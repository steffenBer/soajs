'use strict';

var core = require('../../modules/soajs.core');
var provision = require("../../modules/soajs.provision");
var MultiTenantSession = require("../../classes/MultiTenantSession");
var uracDriver = require("./urac.js");

var async = require("async");
var Netmask = require('netmask').Netmask;
var useragent = require('useragent');
var merge = require('merge');

/**
 *
 * @param configuration
 * @returns {Function}
 */
module.exports = function (configuration) {
    var soajs = configuration.soajs;
    var param = configuration.param;
    var app = configuration.app;

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function serviceCheck(obj, cb) {
        var system = _system.getAcl(obj);
        if (system)
            return cb(null, obj);
        else
            return cb(154);
    }

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function securityGeoCheck(obj, cb) {
        var clientIp = obj.req.getClientIP();
        var geoAccess = obj.keyObj.geo; //{"allow": ["127.0.0.1"], "deny": []};
        obj.geo = {"ip": clientIp};

        var checkAccess = function (geoAccessArr, ip) {
            var check = geoAccessArr.some(function (addr) {
                try {
                    var block = new Netmask(addr);
                    return block.contains(ip);
                } catch (err) {
                    obj.req.soajs.log.error('Geographic security configuration failed: ', addr);
                    obj.req.soajs.log.error(err);
                }
                return false;
            });
            return check;
        };

        if (clientIp && geoAccess && geoAccess.deny && Array.isArray(geoAccess.deny)) {
            var denied = checkAccess(geoAccess.deny, clientIp);
            if (denied)
                return cb(155);
        }

        if (clientIp && geoAccess && geoAccess.allow && Array.isArray(geoAccess.allow)) {
            var allowed = checkAccess(geoAccess.allow, clientIp);
            if (!allowed)
                return cb(155);
        }

        return cb(null, obj);
    }

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function securityDeviceCheck(obj, cb) {
        var clientUA = obj.req.getClientUserAgent();
        var deviceAccess = obj.keyObj.device; //{"allow": [{"family": "chrome"}], "deny": []};
        obj.device = clientUA;

        var validateField = function (fieldName, uaObj, da) {
            if (da[fieldName] && da[fieldName] !== '*' && uaObj[fieldName]) {
                if (typeof (da[fieldName]) === 'string') {
                    if (da[fieldName].trim().toUpperCase() !== uaObj[fieldName].trim().toUpperCase()) {
                        return false;
                    }
                    if (da[fieldName].min) {
                        if (da[fieldName].min.trim() > uaObj[fieldName].trim()) {
                            return false;
                        }
                    }
                }
                if (da[fieldName].max) {
                    if (da[fieldName].max.trim() < uaObj[fieldName].trim()) {
                        return false;
                    }
                }
            }
            return true;
        };

        var checkAccess = function (deviceAccessArr, ua) {
            var uaObj = useragent.lookup(ua);
            //if (uaObj && uaObj.family && uaObj.os && uaObj.os.family) {
            if (uaObj && uaObj.family) {
                var check = deviceAccessArr.some(function (da) {
                    if (!da) {
                        return false;
                    }
                    if (da.family && da.family !== '*') {
                        if (da.family.trim().toUpperCase() !== uaObj.family.trim().toUpperCase()) {
                            return false;
                        }
                    }
                    if (da.os && da.os !== '*') {
                        if (uaObj.os && uaObj.os.family) {
                            if (uaObj.os.family.trim().toUpperCase().indexOf(da.os.family.trim().toUpperCase()) === -1) {
                                return false;
                            }
                            if (!validateField('major', uaObj.os, da.os)) {
                                return false;
                            }
                            if (!validateField('minor', uaObj.os, da.os)) {
                                return false;
                            }
                            if (!validateField('patch', uaObj.os, da.os)) {
                                return false;
                            }
                        }
                        else {
                            return false;
                        }
                    }
                    if (!validateField('major', uaObj, da)) {
                        return false;
                    }
                    if (!validateField('minor', uaObj, da)) {
                        return false;
                    }
                    if (!validateField('patch', uaObj, da)) {
                        return false;
                    }
                    return true;
                });
                return check;
            }
        };

        if (clientUA && deviceAccess && deviceAccess.deny && Array.isArray(deviceAccess.deny)) {
            var denied = checkAccess(deviceAccess.deny, clientUA);
            if (denied) {
                return cb(156);
            }
        }

        if (clientUA && deviceAccess && deviceAccess.allow && Array.isArray(deviceAccess.allow)) {
            var allowed = checkAccess(deviceAccess.allow, clientUA);
            if (!allowed) {
                return cb(156);
            }
        }

        return cb(null, obj);
    }

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function sessionCheck(obj, cb) {
        var mtSessionParam = {
            'session': obj.req.session,
            'tenant': {'id': obj.keyObj.tenant.id, 'key': obj.keyObj.key, 'extKey': obj.keyObj.extKey},
            'product': {
                'product': obj.keyObj.application.product,
                'package': obj.keyObj.application.package,
                'appId': obj.keyObj.application.appId
            },
            'request': {'service': obj.app.soajs.param.serviceName, 'api': obj.req.route.path},
            'device': obj.device,
            'geo': obj.geo,
            'req': obj.req
        };
        var mtSession = new MultiTenantSession(mtSessionParam);
        obj.req.soajs.session = mtSession;
        return cb(null, obj);
    }

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function uracCheck(obj, cb) {
        var callURACDriver = function () {
            var urac = new uracDriver({"soajs": obj.req.soajs, "oauth": obj.req.oauth});
            urac.init(function (error, uracProfile) {
                if (error)
                    obj.req.soajs.log.error(error);

                obj.req.soajs.uracDriver = urac;

                var userServiceConf = urac.getConfig();
                userServiceConf = userServiceConf || {};

                var tenantServiceConf = obj.keyObj.config;
                obj.req.soajs.servicesConfig = merge.recursive(true, tenantServiceConf, userServiceConf);

                return cb(null, obj);
            });
        };
        if (obj.req && obj.req.oauth && obj.req.oauth.bearerToken && obj.req.oauth.bearerToken.env === "dashboard") {
            obj.soajs.tenant.roaming = {
                "tId": obj.req.oauth.bearerToken.clientId,
                "userId": obj.req.oauth.bearerToken.userId
            };
            provision.getTenantData(obj.req.oauth.bearerToken.clientId, function (error, tenant) {
                if (error || !tenant) {
                    return cb(error);
                }
                obj.soajs.tenant.roaming.code = tenant.code;
                return callURACDriver();
            });
        }
        else {
            return callURACDriver();
        }
    }

    /**
     *
     * @param obj
     * @param cb
     * @returns {*}
     */
    function apiCheck(obj, cb) {
        var system = _system.getAcl(obj);
        var api = (system && system.apis ? system.apis[obj.req.route.path] : null);
        if (!api && system && system.apisRegExp && Object.keys(system.apisRegExp).length) {
            for (var jj = 0; jj < system.apisRegExp.length; jj++) {
                if (system.apisRegExp[jj].regExp && obj.req.route.path.match(system.apisRegExp[jj].regExp)) {
                    api = system.apisRegExp[jj];
                }
            }
        }
        var apiRes = null;
        if (system && system.access) {
            if (_urac.getUser(obj.req)) {
                if (system.access instanceof Array) {
                    var checkAPI = false;
                    var userGroups = _urac.getGroups(obj.req);
                    if (userGroups) {
                        for (var ii = 0; ii < userGroups.length; ii++) {
                            if (system.access.indexOf(userGroups[ii]) !== -1)
                                checkAPI = true;
                        }
                    }
                    if (!checkAPI)
                        return cb(157);
                }
            } else {
                if (!api || api.access)
                    return cb(158);
            }
            apiRes = _api.checkPermission(system, obj.req, api);
            if (apiRes.result)
                return cb(null, obj);
            else
                return cb(apiRes.error);
        }
        if (api || (system && ('restricted' === system.apisPermission))) {
            apiRes = _api.checkPermission(system, obj.req, api);
            if (apiRes.result)
                return cb(null, obj);
            else
                return cb(apiRes.error);
        }
        else
            return cb(null, obj);
    }

    /**
     *
     * @param obj
     * @param cb
     */
    function persistSession(obj, cb) {
        obj.req.sessionStore.set(obj.req.sessionID, obj.req.session, function (err, data) {
            if (err) {
                obj.req.soajs.log.error(err);
                return cb(163);
            }
            core.security.authorization.set(obj.res, obj.req.sessionID);
            return cb(null, obj);
        });
    }

    /**
     *
     * @type {{getAcl: "getAcl"}}
     * @private
     */
    var _system = {
        "getAcl": function (obj) {
            var aclObj = null;
            if (obj.req.soajs.uracDriver) {
                var uracACL = obj.req.soajs.uracDriver.getAcl();
                if (uracACL)
                    aclObj = uracACL[obj.app.soajs.param.serviceName];
            }
            if (!aclObj && obj.keyObj.application.acl) {
                aclObj = obj.keyObj.application.acl[obj.app.soajs.param.serviceName];
            }
            if (!aclObj && obj.packObj.acl)
                aclObj = obj.packObj.acl[obj.app.soajs.param.serviceName];

            if (aclObj && (aclObj.apis || aclObj.apisRegExp))
                return aclObj;
            else {
                //ACL with method support restful
                var method = obj.req.method.toLocaleLowerCase();
                if (aclObj && aclObj[method] && typeof aclObj[method] === "object") {
                    var newAclObj = {};
                    if (aclObj.hasOwnProperty('access'))
                        newAclObj.access = aclObj.access;
                    if (aclObj[method].hasOwnProperty('apis'))
                        newAclObj.apis = aclObj[method].apis;
                    if (aclObj[method].hasOwnProperty('apisRegExp'))
                        newAclObj.apisRegExp = aclObj[method].apisRegExp;
                    if (aclObj[method].hasOwnProperty('apisPermission'))
                        newAclObj.apisPermission = aclObj[method].apisPermission;
                    else if (aclObj.hasOwnProperty('apisPermission'))
                        newAclObj.apisPermission = aclObj.apisPermission;
                    return newAclObj;
                }
                else
                    return aclObj;
            }
        }
    };

    /**
     *
     * @type {{getUser: "getUser", getGroups: "getGroups"}}
     * @private
     */
    var _urac = {
        "getUser": function (req) {
            var urac = null;
            if (req.soajs.uracDriver)
                urac = req.soajs.uracDriver.getProfile();
            return urac;
        },
        "getGroups": function (req) {
            var groups = null;
            if (req.soajs.uracDriver)
                groups = req.soajs.uracDriver.getGroups();
            return groups;
        }
    };

    /**
     *
     * @type {{checkPermission: "checkPermission", checkAccess: "checkAccess"}}
     * @private
     */
    var _api = {
        "checkPermission": function (system, req, api) {
            if ('restricted' === system.apisPermission) {
                if (!api)
                    return {"result": false, "error": 159};
                return _api.checkAccess(api.access, req);
            }
            if (!api)
                return {"result": true};
            return _api.checkAccess(api.access, req);
        },
        "checkAccess": function (apiAccess, req) {
            if (!apiAccess)
                return {"result": true};
            if (!_urac.getUser(req))
                return {"result": false, "error": 161};
            if (apiAccess instanceof Array) {
                var userGroups = _urac.getGroups(req);
                if (!userGroups)
                    return {"result": false, "error": 160};
                for (var ii = 0; ii < userGroups.length; ii++) {
                    if (apiAccess.indexOf(userGroups[ii]) !== -1)
                        return {"result": true};
                }
                return {"result": false, "error": 160};
            }
            else
                return {"result": true};
        }
    };

    return function (req, res, next) {
        if (req.soajs.registry.services[soajs.param.serviceName].extKeyRequired) {
            try {
                provision.getExternalKeyData(req.get("key"), req.soajs.registry.serviceConfig.key, function (err, keyObj) {
                    if (err)
                        req.soajs.log.warn(err);
                    if (keyObj && keyObj.application && keyObj.application.package) {
                        req.soajs.tenant = keyObj.tenant;
                        req.soajs.tenant.key = {
                            "iKey": keyObj.key,
                            "eKey": keyObj.extKey
                        };
                        req.soajs.tenant.application = keyObj.application;
                        provision.getPackageData(keyObj.application.package, function (err, packObj) {
                            if (err)
                                req.soajs.log.warn(err);
                            if (packObj) {
                                req.soajs.tenant.application.package_acl = packObj.acl;
                                req.soajs.tenant.application.package_acl_all_env = packObj.acl_all_env;
                                var serviceCheckArray = [function (cb) {
                                    cb(null, {
                                        "app": app,
                                        "res": res,
                                        "req": req,
                                        "keyObj": keyObj,
                                        "packObj": packObj
                                    });
                                }];

                                if (param.security) {
                                    serviceCheckArray.push(securityGeoCheck);
                                    serviceCheckArray.push(securityDeviceCheck);
                                }

                                if (param.session)
                                    serviceCheckArray.push(sessionCheck);

                                if (param.multitenant) {
                                    serviceCheckArray.push(uracCheck);
                                    serviceCheckArray.push(serviceCheck);
                                }

                                if (param.multitenant && param.acl)
                                    serviceCheckArray.push(apiCheck);

                                if (param.session)
                                    serviceCheckArray.push(persistSession);

                                async.waterfall(serviceCheckArray, function (err, data) {
                                    if (err)
                                        return next(err);
                                    else
                                        return next();
                                });
                            }
                            else
                                return next(152);
                        });
                    }
                    else
                        return next(153);
                });
            } catch (err) {
                req.soajs.log.error(150, err.stack);
                res.jsonp(req.soajs.buildResponse(core.error.getError(150)));
            }
        }
        else {
            return next();
        }
    };
};
