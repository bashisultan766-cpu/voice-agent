"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = getEnv;
exports.getEnvOptional = getEnvOptional;
function getEnv(key, defaultValue) {
    var _a;
    var value = (_a = process.env[key]) !== null && _a !== void 0 ? _a : defaultValue;
    if (value === undefined)
        throw new Error("Missing env: ".concat(key));
    return value;
}
function getEnvOptional(key) {
    return process.env[key];
}
