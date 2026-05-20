export declare class RootController {
    root(): {
        service: string;
        message: string;
        adminUi: string;
        endpoints: {
            health: string;
            twilioConfigCheck: string;
            twilioInboundVoice: string;
        };
    };
}
