"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RootController = void 0;
const common_1 = require("@nestjs/common");
const public_decorator_1 = require("../../common/decorators/public.decorator");
let RootController = class RootController {
    root() {
        return {
            service: 'Voice Agent API',
            message: 'This is the API. The admin UI is the Next.js app (usually http://127.0.0.1:3000). Routes live under /api.',
            adminUi: 'http://127.0.0.1:3000',
            endpoints: {
                health: '/api/health',
                twilioConfigCheck: '/api/twilio/config-check',
                twilioInboundVoice: '/api/twilio/voice/inbound',
            },
        };
    }
};
exports.RootController = RootController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], RootController.prototype, "root", null);
exports.RootController = RootController = __decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Controller)()
], RootController);
//# sourceMappingURL=root.controller.js.map