"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserId = void 0;
const common_1 = require("@nestjs/common");
exports.UserId = (0, common_1.createParamDecorator)((_data, ctx) => {
    const id = ctx.switchToHttp().getRequest().userId;
    if (!id)
        throw new common_1.UnauthorizedException();
    return id;
});
//# sourceMappingURL=user-id.decorator.js.map