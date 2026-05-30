"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElevenLabsModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const elevenlabs_service_1 = require("./elevenlabs.service");
const elevenlabs_streaming_service_1 = require("./elevenlabs-streaming.service");
const elevenlabs_controller_1 = require("./elevenlabs.controller");
const elevenlabs_twilio_controller_1 = require("./elevenlabs-twilio.controller");
const elevenlabs_twilio_register_call_service_1 = require("./elevenlabs-twilio-register-call.service");
let ElevenLabsModule = class ElevenLabsModule {
};
exports.ElevenLabsModule = ElevenLabsModule;
exports.ElevenLabsModule = ElevenLabsModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        controllers: [elevenlabs_controller_1.ElevenLabsController, elevenlabs_twilio_controller_1.ElevenLabsTwilioController],
        providers: [elevenlabs_service_1.ElevenLabsService, elevenlabs_streaming_service_1.ElevenLabsStreamingService, elevenlabs_twilio_register_call_service_1.ElevenLabsTwilioRegisterCallService],
        exports: [elevenlabs_service_1.ElevenLabsService, elevenlabs_streaming_service_1.ElevenLabsStreamingService, elevenlabs_twilio_register_call_service_1.ElevenLabsTwilioRegisterCallService],
    })
], ElevenLabsModule);
//# sourceMappingURL=elevenlabs.module.js.map