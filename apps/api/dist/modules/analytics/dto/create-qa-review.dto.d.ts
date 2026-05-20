export declare class CreateQaReviewDto {
    reviewerUserId?: string;
    accuracyScore?: number;
    toneScore?: number;
    policyComplianceScore?: number;
    brevityScore?: number;
    notes?: string;
    needsPromptUpdate?: boolean;
    needsFaqUpdate?: boolean;
}
