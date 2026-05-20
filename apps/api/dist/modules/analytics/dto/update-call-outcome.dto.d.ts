import { CallResolutionStatus } from '@prisma/client';
export declare class UpdateCallOutcomeDto {
    resolutionStatus?: CallResolutionStatus;
    primaryIntent?: string;
    secondaryIntent?: string;
    summary?: string;
    qaScore?: number;
}
