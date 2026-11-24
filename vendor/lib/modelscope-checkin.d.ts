import { type ClaimOutcome } from './credits.js';
import type { ModelscopeCredential } from './modelscope.js';
export declare function modelscopeDailyGrantExpiry(apiKey: string, now?: number): Promise<number | undefined>;
export declare function claimModelscopeDaily(credential: ModelscopeCredential): Promise<ClaimOutcome>;
//# sourceMappingURL=modelscope-checkin.d.ts.map