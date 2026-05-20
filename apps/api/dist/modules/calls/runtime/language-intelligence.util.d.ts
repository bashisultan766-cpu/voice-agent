export interface LanguageDetectionResult {
    language: string;
    confidence: number;
}
export declare function languageDisplayName(code: string | null | undefined): string;
export declare function detectLanguageFromText(text: string): LanguageDetectionResult;
export declare function normalizeLanguageForTwilio(language: string | null | undefined): string;
