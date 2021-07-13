const timing = require('./timing');
const Buffer = require('buffer').Buffer;
const bufferCreate = Buffer;
const pull = require('pull-stream');
const pullStream = require('stream-to-pull-stream');
const paramap = require('pull-paramap');
const DISCARD = Symbol('ut-port.pull.DISCARD');
const CONNECTED = Symbol('ut-port.pull.CONNECTED');
const IGNORE = Symbol('ut-port.pull.IGNORE'); // pass this packet without processing
const DEADLOCK = Symbol('ut-port.pull.DEADLOCK');
const timeoutManager = require('./timeout');
const uuid = require('uuid').v4;
const {utMeta} = require('./meta');

const portErrorDispatch = async(port, $meta, dispatchError) => {
    port.error(dispatchError, $meta);
    $meta.mtid = 'error';
    $meta.errorCode = dispatchError && dispatchError.code;
    $meta.errorMessage = dispatchError && dispatchError.message;
    await portDispatch(port)([dispatchError, $meta]);
    return [DISCARD, $meta];
};

const portErrorReceive = async(port, $meta, receiveError) => {
    port.error(receiveError, $meta);
    $meta.mtid = 'error';
    $meta.errorCode = receiveError && receiveError.code;
    $meta.errorMessage = receiveError && receiveError.message;
    return [receiveError, $meta];
};

const portTimeoutDispatch = (port, sendQueue) => async $meta => {
    if (sendQueue && !$meta.dispatch && $meta.mtid === 'request') {
        $meta.dispatch = (...packet) => {
            delete $meta.dispatch;
            sendQueue.push(packet);
            return [DISCARD];
        };
    }
    try {
        return portErrorDispatch(port, $meta, port.errors['port.timeout']());
    } catch (error) {
        port.error(error, $meta);
    }
};

const packetTimer = (method, aggregate = '*', id, timeout) => {
    if (!method) {
        return;
    }
    let time = timing.now();
    const times = {
        port: id,
        method,
        aggregate,
        queue: undefined,
        receive: undefined,
        encode: undefined,
        exec: undefined,
        decode: undefined,
        send: undefined,
        dispatch: undefined,
        calls: undefined
    };

    return (what, newtime = timing.now()) => {
        if (typeof what === 'object') {
            times.calls = times.calls || [];
            times.calls.push(what);
            return;
        }
        what && (times[what] = timing.diff(time, newtime));
        time = newtime;
        if (what) {
            if (timing.isAfter(newtime, timeout)) {
                timeout = false;
                return true;
            } else {
                return false;
            }
        }
        return times;
    };
};

const calcTime = (port, stage, onTimeout) => pull(
    pull.filter(packetFilter => {
        if (packetFilter && packetFilter[IGNORE]) return true;
        const $meta = packetFilter && packetFilter.length > 1 && packetFilter[packetFilter.length - 1];
        if ($meta && $meta.timer && $meta.timer(stage)) {
            onTimeout && onTimeout($meta);
            return false;
        }
        return (packetFilter && packetFilter[0] !== DISCARD);
    }),
    pull.map(packetThrow => {
        if (packetThrow && (
            (packetThrow[0] instanceof Error && packetThrow[0].type === 'port.disconnect') ||
            (packetThrow[0] instanceof Error && packetThrow[0].type === 'port.receiveTimeout')
        )) {
            throw packetThrow[0];
        } else {
            return packetThrow;
        }
    })
);

const reportTimes = (port, $meta) => {
    if ($meta && $meta.timer && port.methodLatency && $meta.mtid !== 'request') {
        const times = $meta.timer();
        port.methodLatency(times.method, {m: times.method}, [
            times.queue,
            times.receive,
            times.encode,
            times.exec,
            times.decode,
            times.send,
            times.dispatch
        ], 1);
        times.aggregate && port.methodLatency(times.aggregate, {m: times.aggregate}, [
            times.queue,
            times.receive,
            times.encode,
            times.exec,
            times.decode,
            times.send,
            times.dispatch
        ], 1);
        delete times.aggregate;
        $meta.calls = times;
        delete $meta.timer;
    }
};

const traceMeta = (port, context, $meta, set, get, time) => {
    if ($meta && !$meta.timer && $meta.mtid === 'request') {
        $meta.timer = packetTimer(port.bus.getPath($meta.method), '*', port.config.id, $meta.timeout);
    }
    if ($meta && $meta.trace && context) {
        if ($meta.mtid === 'request') { // todo improve what needs to be tracked
            context.requests.set(set + $meta.trace, {
                $meta,
                end: !time && timeoutManager.startRequest($meta, port.errors['port.timeout'], error => {
                    context.requests.delete(set + $meta.trace);
                    $meta.mtid = 'error';
                    $meta.dispatch && $meta.dispatch(error, $meta);
                })
            });
            return $meta;
        } else if ($meta.mtid === 'response' || $meta.mtid === 'error') {
            const request = context.requests.get(get + $meta.trace);
            if (request) {
                context.requests.delete(get + $meta.trace);
                request.end && request.end();
                request.$meta && request.$meta.timer && time && request.$meta.timer('exec', time);
                return Object.assign(request.$meta, $meta);
            } else {
                return $meta;
            }
        }
    } else {
        return $meta;
    }
};

const portSend = (port, context) => async sendPacket => {
    const $meta = sendPacket.length > 1 && sendPacket[sendPacket.length - 1];
    if (sendPacket[DEADLOCK]) return portErrorDispatch(port, $meta || {}, sendPacket[DEADLOCK]);
    try {
        const validate = port.findValidation($meta);
        if (validate) sendPacket[0] = validate.apply(port, sendPacket);
        const {fn, name} = port.getConversion($meta, 'send');
        if (fn) {
            sendPacket[0] = await fn.apply(port, Array.prototype.concat(sendPacket, context));
            port.log.trace && port.log.trace({
                message: sendPacket,
                $meta: {method: name, mtid: 'convert'},
                ...context && context.session && {log: context.session.log}
            });
        }
    } catch (error) {
        return portErrorDispatch(port, $meta || {}, error);
    }
    return sendPacket;
};

const portEncode = (port, context) => async encodePacket => {
    const $meta = encodePacket.length > 1 && encodePacket[encodePacket.length - 1];
    port.log.debug && port.log.debug({
        message: typeof encodePacket[0] === 'object' ? encodePacket[0] : {value: encodePacket[0]},
        $meta,
        ...context && context.session && {log: context.session.log}
    });
    try {
        let encodeBuffer = port.codec ? await port.codec.encode(encodePacket[0], $meta, context, port.log) : encodePacket;
        let size;
        let sizeAdjust = 0;
        traceMeta(port, context, $meta, 'out/', 'in/');
        if (port.codec) {
            if (port.framePatternSize) {
                sizeAdjust = port.config.format.sizeAdjust;
            }
            size = encodeBuffer && encodeBuffer.length + sizeAdjust;
        } else {
            size = encodeBuffer && encodeBuffer.length;
        }
        if (port.frameBuilder) {
            encodeBuffer = port.frameBuilder({size: size, data: encodeBuffer});
            encodeBuffer = encodeBuffer.slice(0, encodeBuffer.length - sizeAdjust);
            port.bytesSent && port.bytesSent(encodeBuffer.length);
        }
        if (encodeBuffer) {
            port.msgSent && port.msgSent(1);
            !port.codec && port.log.trace && port.log.trace({
                $meta: {
                    mtid: 'payload',
                    method: $meta.method ? $meta.method + '.encode' : 'port.encode'
                },
                message: encodeBuffer,
                ...context && context.session && {log: context.session.log}
            });
            return port.frameBuilder ? [encodeBuffer, $meta] : encodeBuffer;
        }
        return [DISCARD, $meta];
    } catch (error) {
        return portErrorDispatch(port, $meta, error);
    }
};

const portUnpack = port => pull.map(unpackPacket => port.frameBuilder ? unpackPacket[0] : unpackPacket);

const portIdleSend = (port, context, queue) => {
    let timer;
    if (port.config.idleSend) {
        const idleSendReset = () => {
            timer && clearTimeout(timer);
            timer = setTimeout(() => {
                if (port.isReady) portEventDispatch(port, context, DISCARD, 'idleSend', port.log.trace, queue);
                idleSendReset();
            }, port.config.idleSend);
        };
        idleSendReset();
        return pull.through(packet => {
            idleSendReset();
            return packet;
        }, () => {
            timer && clearTimeout(timer);
            timer = null;
        });
    }
};

const portExec = (port, fn) => execPacket => {
    const $meta = execPacket.length > 1 && execPacket[execPacket.length - 1];
    if ($meta && $meta.mtid === 'request') {
        $meta.mtid = 'response';
    }
    if ($meta && $meta.mtid === 'notification') {
        $meta.mtid = 'discard';
    }
    return Promise.resolve()
        .then(function execCall() {
            return fn.apply(port, execPacket);
        })
        .then(execResult => [execResult, $meta])
        .catch(execError => {
            port.error(execError, $meta);
            if ($meta) {
                $meta.mtid = 'error';
            }
            return [execError, $meta];
        });
};

const getFrame = (port, buffer) => {
    let result;
    let size;
    if (port.framePatternSize) {
        const tmp = port.framePatternSize(buffer);
        if (tmp) {
            size = tmp.size;
            result = port.framePattern(tmp.data, {size: tmp.size - port.config.format.sizeAdjust});
        } else {
            result = false;
        }
    } else {
        result = port.framePattern(buffer);
    }
    if (port.config.maxReceiveBuffer) {
        if (!result && buffer.length > port.config.maxReceiveBuffer) {
            throw port.errors['port.bufferOverflow']({params: {max: port.config.maxReceiveBuffer, size: buffer.length}});
        }
        if (!result && size > port.config.maxReceiveBuffer) { // fail early
            throw port.errors['port.bufferOverflow']({params: {max: port.config.maxReceiveBuffer, size: size}});
        }
    }
    return result;
};

const portUnframe = (port, context, buffer) => {
    return port.framePattern && pull(
        pull.map(datagram => {
            const result = [];
            port.bytesReceived && port.bytesReceived(datagram.length);
            !port.codec && port.log.trace && port.log.trace({
                $meta: {mtid: 'payload', method: 'port.decode'},
                message: datagram,
                ...context && context.session && {log: context.session.log}
            });
            // todo check buffer size
            buffer = Buffer.concat([buffer, datagram]);
            let dataPacket;
            while ((dataPacket = getFrame(port, buffer))) {
                buffer = dataPacket.rest;
                result.push(dataPacket.data);
            }
            return result;
        }),
        pull.flatten()
    );
};

const metaFromContext = (context, rest) => ({
    ...context && {
        conId: context.conId
    },
    forward: {
        'x-b3-traceid': uuid().replace(/-/g, '')
    },
    ...rest
});

const portDecode = (port, context) => dataPacket => {
    const time = timing.now();
    port.msgReceived && port.msgReceived(1);
    if (port.codec) {
        const $meta = metaFromContext(context);
        return Promise.resolve()
            .then(function decodeCall() {
                return port.codec.decode(dataPacket, $meta, context, port.log);
            })
            .then(decodeResult => [decodeResult, traceMeta(port, context, $meta, 'in/', 'out/', time)])
            .catch(decodeError => {
                $meta.mtid = 'error';
                if (!decodeError || !decodeError.keepConnection) {
                    return [port.errors['port.disconnect'](decodeError), $meta];
                } else {
                    return [decodeError, $meta];
                }
            });
    } else if (dataPacket && dataPacket.constructor && dataPacket.constructor.name === 'Buffer') {
        return Promise.resolve([{payload: dataPacket}, metaFromContext(context, {mtid: 'notification', opcode: 'payload'})]);
    } else {
        const $meta = (dataPacket.length > 1) && dataPacket[dataPacket.length - 1];
        $meta && context && context.conId && ($meta.conId = context.conId);
        (dataPacket.length > 1) && (dataPacket[dataPacket.length - 1] = traceMeta(port, context, $meta, 'in/', 'out/', time));
        return Promise.resolve(dataPacket);
    }
};

const portIdleReceive = (port, context, queue) => {
    let timer;
    if (port.config.idleReceive) {
        const idleReceiveReset = () => {
            timer && clearTimeout(timer);
            timer = setTimeout(() => {
                portEventDispatch(
                    port,
                    context,
                    port.errors['port.receiveTimeout']({params: {timeout: port.config.idleReceive}}),
                    'idleReceive',
                    port.log.trace,
                    queue
                );
                idleReceiveReset();
            }, port.config.idleReceive);
        };
        idleReceiveReset();
        return pull.through(packet => {
            idleReceiveReset();
            return packet;
        }, () => {
            timer && clearTimeout(timer);
            timer = null;
        });
    }
};

const portReceive = (port, context) => async receivePacket => {
    const $meta = receivePacket.length > 1 && receivePacket[receivePacket.length - 1];
    if (receivePacket[DEADLOCK]) return portErrorReceive(port, $meta || {}, receivePacket[DEADLOCK]);
    try {
        const {fn, name} = port.getConversion($meta, 'receive');
        if (fn) {
            receivePacket[0] = await fn.apply(port, Array.prototype.concat(receivePacket, context));
            port.log.trace && port.log.trace({
                message: receivePacket,
                $meta: { method: name, mtid: 'convert' },
                ...context && context.session && { log: context.session.log }
            });
        }
        const validate = port.findValidation($meta);
        if (validate) receivePacket[0] = validate.apply(port, receivePacket);
    } catch (error) {
        return portErrorReceive(port, $meta || {}, error);
    }
    return receivePacket;
};

const portQueueEventCreate = (port, context, message, event, logger) => {
    context && (typeof logger === 'function') && logger({
        $meta: {mtid: 'event', method: 'port.' + event},
        connection: context,
        ...context && context.session && {log: context.session.log}
    });
    if (event === 'disconnected') {
        if (context && context.requests && context.requests.size) {
            Array.from(context.requests.values()).forEach(request => {
                request.$meta.mtid = 'error';
                request.$meta.dispatch && request.$meta.dispatch(port.errors['port.disconnectBeforeResponse'](), request.$meta);
            });
            context.requests.clear();
        }
        if (context && context.waiting && context.waiting.size) {
            Array.from(context.waiting.values()).forEach(end => {
                end(port.errors['port.disconnectBeforeResponse']());
            });
        }
    }
    return [message, utMeta({
        mtid: 'event',
        method: event,
        conId: context && context.conId,
        timer: packetTimer('event.' + event, false, port.config.id)
    })];
};

const portEventDispatch = (port, context, message, event, logger, queue) => pull(
    pull.once(portQueueEventCreate(port, context, message, event, logger)),
    paraPromise(port, context, portReceive(port, context), port.activeReceiveCount), calcTime(port, 'receive'),
    paraPromise(port, context, portDispatch(port), port.activeDispatchCount), calcTime(port, 'dispatch'),
    portSink(port, queue)
);

const portDispatch = port => dispatchPacket => {
    const $meta = (dispatchPacket.length > 1 && dispatchPacket[dispatchPacket.length - 1]) || {};
    if ($meta && $meta.dispatch) {
        reportTimes(port, $meta);
        return Promise.resolve().then(() => $meta.dispatch.apply(port, dispatchPacket));
    }
    if (!dispatchPacket || !dispatchPacket[0] || dispatchPacket[0] === DISCARD) {
        return Promise.resolve([DISCARD]);
    }
    if (dispatchPacket[0] === CONNECTED) {
        return Promise.resolve([CONNECTED]);
    }
    const mtid = $meta.mtid;
    const opcode = $meta.opcode;
    const method = $meta.method;

    const portDispatchResult = isError => dispatchResult => {
        const $metaResult = (dispatchResult.length > 1 && dispatchResult[dispatchResult.length - 1]) || {};
        if (mtid === 'request' && $metaResult.mtid !== 'discard') {
            if (!$metaResult.opcode) $metaResult.opcode = opcode;
            if (!$metaResult.method) $metaResult.method = method;
            $metaResult.mtid = isError ? 'error' : 'response';
            $metaResult.reply = $meta.reply;
            $metaResult.timer = $meta.timer;
            $metaResult.dispatch = $meta.dispatch;
            $metaResult.trace = $meta.trace;
            if ($meta.request) $metaResult.request = $meta.request;
            if (isError) {
                port.error(dispatchResult, $meta);
                return [dispatchResult, $metaResult];
            } else {
                return dispatchResult;
            }
        } else {
            return [DISCARD];
        }
    };

    if (mtid === 'error') {
        if (port.config.disconnectOnError) {
            return Promise.reject(port.errors['port.unhandled'](dispatchPacket[0]));
        } else {
            return Promise.resolve(dispatchPacket);
        }
    }

    return Promise.resolve()
        .then(() => port.messageDispatch.apply(port, dispatchPacket))
        .then(portDispatchResult(false), portDispatchResult(true));
};

const portSink = (port, queue) => pull.drain(sinkPacket => {
    if (sinkPacket && sinkPacket[0] === CONNECTED) {
        typeof queue.start === 'function' && queue.start();
    } else {
        queue && queue.push(sinkPacket);
    }
}, sinkError => {
    try {
        sinkError && port.error(sinkError);
    } finally {
        sinkError && queue && queue.end(sinkError);
    }
});

const paraPromise = (port, context, fn, counter, concurrency = 1) => {
    let active = 0;
    counter && counter(active);
    return paramap((params, cb) => {
        if (params[IGNORE]) {
            cb(null, params);
            return;
        }
        active++;
        counter && counter(active);
        const $meta = params.length > 1 && params[params.length - 1];
        timeoutManager.startPromise(params, fn, $meta, port.errors['port.timeout'], context && context.waiting)
            .then(promiseResult => {
                active--;
                counter && counter(active);
                cb(null, promiseResult);
                return true;
            }, promiseError => {
                active--;
                counter && counter(active);
                cb(promiseError);
            })
            .catch(cbError => {
                port.error(cbError, $meta);
                cb(cbError);
            });
    }, concurrency, false);
};

const portDuplex = (port, context, stream, sendQueue) => {
    const cleanup = () => {
        stream.removeListener('data', streamData);
        stream.removeListener('close', streamClose);
        stream.removeListener('error', streamError);
    };
    let closed = false;
    const receiveQueue = port.receiveQueues.create({
        context,
        close: () => {
            !closed && stream.end();
        }
    });
    const streamData = data => {
        receiveQueue.push(data);
    };
    const streamClose = () => {
        closed = true;
        cleanup();
        try {
            portEventDispatch(port, context, DISCARD, 'disconnected', port.log.info);
        } finally {
            receiveQueue.end();
            sendQueue.end();
        }
    };
    const streamError = error => {
        port.error(port.errors['port.stream']({context, error}), {method: 'port.pull'});
    };
    stream.on('error', streamError);
    stream.on('close', streamClose);
    stream.on('data', streamData);
    port.config.socketTimeOut && stream.setTimeout(port.config.socketTimeOut, () => {
        stream.destroy(port.errors['port.socketTimeout']({params: {timeout: port.config.socketTimeOut}}));
    });
    const sink = pullStream.sink(stream);
    const source = receiveQueue.source;
    return {
        sink,
        source
    };
};

const drainSend = (port, context) => queueLength => {
    return port.isReady && portEventDispatch(port, context, {length: queueLength, interval: port.config.drainSend}, 'drainSend', port.log.info);
};

const pullExec = (port, context, exec) => pull(
    paraPromise(port, context, portExec(port, exec), port.activeExecCount, port.config.concurrency || 10),
    calcTime(port, 'exec', portTimeoutDispatch(port))
);

const portPull = (port, what, context) => {
    let stream;
    let result;
    context && (context.requests = new Map());
    context && (context.waiting = new Set());
    const sendQueue = port.sendQueues.create({
        min: port.config.minSend,
        max: port.config.maxSend,
        drainInterval: port.config.drainSend,
        drain: (port.config.minSend >= 0 || port.config.drainSend) && drainSend(port, context),
        skipDrain: packet => packet && packet.length > 1 && (packet[packet.length - 1].echo || packet[packet.length - 1].drain === false),
        context
    });
    if (!what || what.exec) {
        const exec = what && what.exec;
        const receiveQueue = port.receiveQueues.create({context});
        stream = {
            sink: pull.drain(replyPacket => {
                const $meta = replyPacket.length > 1 && replyPacket[replyPacket.length - 1];
                reportTimes(port, $meta);
                if ($meta && $meta.reply) {
                    const fn = $meta.reply;
                    delete $meta.reply;
                    try {
                        fn.apply(null, replyPacket);
                    } catch (error) {
                        port.error(error, $meta);
                    }
                } else if (exec) {
                    receiveQueue.push(replyPacket);
                }
            }, () => portEventDispatch(port, context, DISCARD, 'disconnected', port.log.info)),
            source: receiveQueue.source
        };
        result = {
            push: pushPacket => {
                const $meta = (pushPacket.length > 1 && pushPacket[pushPacket.length - 1]);
                $meta.method = $meta && $meta.method && $meta.method.split('/').pop();
                $meta.timer = $meta.timer || packetTimer(port.bus.getPath($meta.method), '*', port.config.id, $meta.timeout);
                if (exec) pushPacket[IGNORE] = true;
                receiveQueue.push(pushPacket);
            }
        };
        if (exec) {
            stream.source = pull(
                stream.source,
                pullExec(port, context, exec),
                pull.map(packet => {
                    if (packet) delete packet[IGNORE];
                    return packet;
                })
            );
        }
    } else if (typeof what === 'function') {
        stream = pullExec(port, context, what);
    } else if (what.readable && what.writable) {
        stream = portDuplex(port, context, what, sendQueue);
    } else {
        throw port.errors['port.invalidPullStream']({params: {stream: what}});
    }
    const send = paraPromise(port, context, portSend(port, context), port.activeSendCount, port.config.concurrency || 10);
    const encode = paraPromise(port, context, portEncode(port, context), port.activeEncodeCount, port.config.concurrency || 10);
    const unpack = portUnpack(port);
    const idleSend = portIdleSend(port, context, sendQueue);
    const unframe = portUnframe(port, context, bufferCreate.alloc(0));
    const decode = paraPromise(port, context, portDecode(port, context), port.activeDecodeCount, port.config.concurrency || 10);
    const idleReceive = portIdleReceive(port, context, sendQueue);
    const receive = paraPromise(port, context, portReceive(port, context), port.activeReceiveCount, port.config.concurrency || 10);
    const dispatch = paraPromise(port, context, portDispatch(port), port.activeDispatchCount, port.config.concurrency || 10);
    const sink = portSink(port, sendQueue);
    const emit = stage => {
        let shouldEmit;
        switch (typeof port.config.emit) {
            case 'string':
                shouldEmit = port.config.emit === 'true';
                break;
            case 'boolean':
                shouldEmit = port.config.emit === true;
                break;
            case 'object':
                shouldEmit = Array.isArray(port.config.emit) && port.config.emit.indexOf(stage) !== -1;
                break;
            default:
                shouldEmit = false;
        }
        // better to return false in order to skip piping instead of returning a dummy through stream
        return shouldEmit && pull.through(
            packet => {
                port.emit(stage, ...packet);
                return packet;
            },
            abort => {
                // not implemented
            }
        );
    };

    const checkDeadlock = port => {
        const stackId = '->' + (port.config.stackId || port.config.id) + '(';
        const extendStack = port.config.debug
            ? (stack, method) => stack + stackId + method + ')'
            : (stack) => stack + stackId + ')';
        const {noRecursion} = port.config;
        let proceed;
        switch (noRecursion) {
            case 'trace':
            case 'debug':
            case 'info':
            case 'warn': {
                proceed = ($meta, error, params) => {
                    if (port.log[noRecursion]) port.log[noRecursion](port.errors[error]({params}));
                    return true;
                };
                break;
            }
            case 'error':
            case true:
                proceed = ($meta, error, params) => {
                    portErrorDispatch(port, $meta, port.errors[error]({params}));
                    return false;
                };
                break;
            default:
                proceed = () => true;
                break;
        }
        return pull.filter(packet => {
            const $meta = packet && packet.length > 1 && packet[packet.length - 1];
            if (!$meta) return proceed($meta, 'port.noMeta');
            if ($meta.mtid !== 'request' && $meta.mtid !== 'notification') return true;
            if (!$meta.forward) return proceed($meta, 'port.noMetaForward', {method: $meta.method});
            const stack = $meta.forward['x-ut-stack'];
            if (!stack && !noRecursion) return true;
            const traceId = $meta.forward['x-b3-traceid'];
            if (!traceId) return proceed($meta, 'port.noTraceId', {method: $meta.method});
            if (!stack && noRecursion) {
                $meta.forward['x-ut-stack'] = extendStack('', $meta.method);
                return true;
            }
            if (stack.indexOf(stackId) < 0) {
                $meta.forward['x-ut-stack'] = extendStack(stack, $meta.method);
                return true;
            }
            return proceed($meta, 'port.deadlock', {method: $meta.method, traceId, sequence: extendStack(stack, $meta.method)});
        });
    };

    pull(
        sendQueue,
        calcTime(port, 'queue', portTimeoutDispatch(port)),
        checkDeadlock(port),
        send,
        calcTime(port, 'send', portTimeoutDispatch(port)),
        emit('send'),
        encode,
        calcTime(port, 'encode', portTimeoutDispatch(port)),
        emit('encode'),
        unpack,
        idleSend,
        stream,
        unframe,
        emit('decode'),
        decode,
        calcTime(port, 'decode', portTimeoutDispatch(port, sendQueue)),
        idleReceive,
        checkDeadlock(port),
        emit('receive'),
        receive,
        calcTime(port, 'receive', portTimeoutDispatch(port, sendQueue)),
        dispatch,
        calcTime(port, 'dispatch'),
        sink
    );
    portEventDispatch(port, context, CONNECTED, 'connected', port.log.info, sendQueue);
    return result;
};

const portFindRoute = (port, $meta, args) => port.sendQueues.get() ||
    port.sendQueues.get($meta) ||
    (typeof port.connRouter === 'function' && port.sendQueues.get({conId: port.connRouter(port.sendQueues, args)}));

const portDrain = (port, args) => {
    const $meta = args[args.length - 1] = Object.assign({}, args[args.length - 1]);
    const queue = portFindRoute(port, $meta, args);
    if (!queue.length()) queue.push([DISCARD]); // force drain on empty queue
    return true;
};

const portPush = (port, promise, args) => {
    if (!args.length) {
        return Promise.reject(port.errors['port.missingParameters']());
    } else if (args.length === 1 || !args[args.length - 1]) {
        return Promise.reject(port.errors['port.missingMeta']());
    }
    const $meta = args[args.length - 1] = Object.assign({}, args[args.length - 1]);
    const queue = portFindRoute(port, $meta, args);
    if (!queue) {
        port.error(port.errors['port.queueNotFound']({args}), $meta);
        return promise ? Promise.reject(port.errors['port.notConnected']()) : false;
    }
    $meta.method = $meta && $meta.method && $meta.method.split('/').pop();
    $meta.timer = packetTimer(port.bus.getPath($meta.method), '*', port.config.id, $meta.timeout);
    if (!promise) {
        $meta.dispatch = () => {
            delete $meta.dispatch;
        }; // caller does not care for result;
        queue.push(args);
        return true;
    }
    return new Promise((resolve, reject) => {
        $meta.dispatch = (...params) => {
            delete $meta.dispatch;
            if ($meta.mtid !== 'error') {
                resolve(params);
            } else {
                reject(params[0]);
            }
            return [DISCARD];
        };
        queue.push(args);
    });
};

module.exports = {
    portPull,
    portPush,
    portDrain,
    packetTimer,
    timeoutManager
};
