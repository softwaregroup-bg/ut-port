const utPort = require('./port');
const merge = require('ut-function.merge');
const {utMeta} = require('./meta');
const lowercase = (match, word1, word2, letter) => `${word1}.${word2.toLowerCase()}${letter ? ('.' + letter.toLowerCase()) : ''}`;
const capitalWords = /^([^A-Z]+)([A-Z][^A-Z]+)([A-Z])?/;
const importKeyRegexp = /^(@[a-z][a-z0-9]*\s)*([a-z][a-z0-9]*\/)?[a-z][a-zA-Z0-9$]+(\.[a-z0-9][a-zA-Z0-9]+)*(#\[[0+?^]?])?$/;
async function portMethod(port, method) {
    try {
        return await (port[method] instanceof Function && port[method]());
    } catch (e) {
        port.error(e, {method});
        throw e;
    }
}
const isHandler = name => name.includes('.') || ['start', 'stop', 'ready', 'init', 'send', 'receive', 'namespace', 'reducer'].includes(name);

module.exports = ({bus, logFactory, assert, vfs, joi, version}) => {
    const servicePorts = new Map();
    const serviceModules = new Map();
    let index = 0;
    const modules = {};
    const proxy = config => {
        const cache = {};
        return new Proxy({}, {
            get(target, key) {
                switch (key) { // do not crash React devTools
                    case Symbol.iterator:
                    case Symbol.toStringTag:
                    case '$$typeof':
                    case 'constructor': return cache[key];
                }
                let result = cache[key];
                if (result) return result;
                const options = {};
                if (!importKeyRegexp.test(key)) throw new Error('wrong import proxy key format');
                const tags = key.split(' ');
                let method = tags.pop().replace(/\$/g, '/');
                if (!method.includes('.')) method = method.replace(capitalWords, lowercase);
                if (config && config.import) {
                    merge([
                        options,
                        ...tags.map(tag => config.import[tag.slice(1)]).filter(Boolean),
                        config.import[method]
                    ]);
                }
                if (method.startsWith('error.')) {
                    const error = bus.errors.getError(method.substr(6));
                    if (!error) throw new Error(`Error ${method.substr(6)} not found`);
                    return error;
                }
                result = bus.importMethod(method, options);
                cache[key] = result;
                return result;
            }
        });
    };

    let stackUtils;
    const callSite = () => {
        if (!stackUtils) stackUtils = new (require('stack-utils'))();
        return {callSite: stackUtils.at(callSite)};
    };

    const factoryParams = (config, base, pkg) => ({
        utLog: logFactory,
        utBus: bus,
        utPort: base,
        utError: bus.errors,
        registerErrors: bus.registerErrors,
        utMethod: Object.assign((...params) => bus.importMethod(...params), {pkg}),
        utNotify: Object.assign((...params) => bus.notification(...params), {pkg}),
        utMeta,
        import: proxy(config),
        callSite,
        config,
        vfs,
        joi,
        version
    });

    const createItem = async({create, moduleName, pkg}, envConfig, base) => {
        const moduleConfig = moduleName ? envConfig[moduleName] : envConfig;
        modules[moduleName || '.'] = modules[moduleName || '.'] || [];
        let config = moduleConfig;
        if (create.name) {
            const globalConfig = envConfig[create.name];
            const localConfig = (moduleConfig || {})[create.name];
            if (globalConfig === localConfig) {
                config = globalConfig;
            } else {
                config = merge({}, {config: globalConfig}, {config: localConfig}).config;
            }
        }
        let Result;
        if (config === false || config === 'false') return;
        index++;
        const createParams = factoryParams(config, base, pkg);
        Result = await create(createParams);
        if (Result instanceof Function) { // item returned a constructor
            if (!Result.name) throw new Error(`Module "${moduleName}${create.name ? '/' + create.name : ''}" returned anonymous constructor:\n${Result}`);
            config = (moduleConfig || {})[Result.name];
            if (config === false || config === 'false') {
                return;
            } else {
                config = config || {};
                if (typeof config !== 'object') config = {};
                config.order = config.order || index;
                config.id = (moduleName ? `${moduleName}.${Result.name}` : Result.name);
                config.pkg = pkg;
                Result = new Result(factoryParams(config, base, pkg));
                servicePorts.set(config.id, Result);
            }
        } else if (Result instanceof Object) {
            if (!create.name) throw new Error(`Module "${moduleName}" returned plain object from anonymous function:\n${create}`);
            const id = moduleName ? `${moduleName}.${create.name}` : create.name;
            const resultConfig = {};
            if (Array.isArray(Result)) {
                const [all, handlers, literals] = await Result.reduce((promise, fn) => {
                    return promise.then(async([lib, prevHandlers, prevLiterals]) => {
                        const literal = await fn({...createParams, lib});
                        Object.entries(literal).forEach(([key, value]) => {
                            if (!isHandler(key)) return;
                            const polyfill = config?.[key];
                            if (polyfill === false) return delete literal[key]; // remove if explicitly set to false
                            if (typeof polyfill === 'object') {
                                if (typeof value === 'function') {
                                    literal[key] = value.constructor.name === 'AsyncFunction'
                                        ? async(...params) => merge(await value(...params), polyfill)
                                        : (...params) => merge(value(...params), polyfill);
                                } else {
                                    literal[key] = merge(value, polyfill);
                                }
                            }
                            prevHandlers[key] = literal[key];
                        });
                        Object.assign(lib, literal);
                        return [lib, prevHandlers, [...prevLiterals, literal]];
                    });
                }, Promise.resolve([{}, {}, []]));
                merge(resultConfig, all.config);
                bus.registerLocal(handlers, id, pkg, literals); // use super in object literals
            } else {
                merge(resultConfig, Result.config);
                bus.registerLocal(Result, id, pkg);
            }
            Result = {
                destroy() {
                    serviceModules.delete(id);
                    bus.unregisterLocal(id);
                },
                start() {
                },
                config: {
                    ...resultConfig,
                    id,
                    type: 'module',
                    order: index,
                    pkg
                },
                init: Result.init
            };
            serviceModules.set(id, Result);
        } else if (Result) {
            throw new Error(`Module "${moduleName}" returned unexpected value:\n${Result}`);
        }
        await (Result && Result.init instanceof Function && Result.init());
        Result && modules[moduleName || '.'].push(Result);
        return Result;
    };

    const create = async(items, envConfig) => {
        const result = [];
        const base = utPort(envConfig.utPort);
        for (const item of items) result.push(await createItem(item, envConfig, base));
        return result.filter(item => item);
    };

    const fetch = filter =>
        Array.from(servicePorts.values())
            .concat(Array.from(serviceModules.values()))
            .sort((a, b) => a.config.order > b.config.order ? 1 : -1);

    const startOne = async({port}) => {
        port = servicePorts.get(port);
        await (port && portMethod(port, 'start'));
        await (bus.ready && bus.ready());
        await (port && portMethod(port, 'ready'));
        return port;
    };

    const startMany = async ports => {
        const portsStarted = [];
        try {
            for (let port of ports) {
                portsStarted.push(port); // collect ports that are started
                port = await portMethod(port, 'start');
                assert && assert.ok(true, 'started port ' + port.config.id);
            }
            await (bus.ready && bus.ready());
            for (const port of portsStarted) {
                await portMethod(port, 'ready');
            }
        } catch (error) {
            for (const port of portsStarted) {
                try {
                    await portMethod(port, 'stop');
                } catch (ignore) { /* just continue calling stop */ }
            }
            throw error;
        }
        return portsStarted;
    };

    const start = params =>
        Array.isArray(params || []) ? startMany(params) : startOne(params);

    const connected = async ports => Promise.all(ports.map(port => port.isConnected));

    const port = {
        get: ({port}) => servicePorts.get(port),
        fetch,
        create,
        start,
        stop: async({port}) => {
            port = servicePorts.get(port);
            await (port && portMethod(port, 'stop'));
            return port;
        },
        connected,
        destroy: async moduleName => {
            const started = modules[moduleName || '.'];
            if (started) {
                for (const item of started) {
                    await item.destroy();
                }
            }
            delete modules[moduleName || '.'];
            bus.reload && await bus.reload();
        },
        move: ({port, x, y}) => {
            port = servicePorts.get(port);
            if (port) {
                port.config.x = x;
                port.config.y = y;
            }
            return port;
        }
    };

    bus.registerLocal({port}, 'ut', require('./package.json'));

    return port;
};
