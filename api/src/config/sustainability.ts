// AI providers — these use inference compute (orders of magnitude more energy per call)
export const AI_PROVIDERS = new Set(["openai"]);

// Energy per API call in kWh, sourced from published data center disclosures and
// ML inference benchmarks. AI inference (GPT-4 class) ≈ 0.003 kWh/call;
// typical REST call ≈ 0.00001 kWh/call.
export const ENERGY_PER_CALL_KWH: Record<string, number> = {
  openai: 0.003,       // LLM inference, GPT-4 class (~3 Wh)
  "aws-s3": 0.000008,  // Object storage I/O
  "google-maps": 0.00003, // Maps/geo compute
  stripe: 0.00002,
  twilio: 0.00001,
  sendgrid: 0.000005,
  internal: 0.000005
};

export const DEFAULT_AI_ENERGY_KWH = 0.001;
export const DEFAULT_REGULAR_ENERGY_KWH = 0.00001;

// Water intensity: liters per kWh consumed
// Source: Microsoft Azure 2022 Environmental Sustainability Report (~1.8 L/kWh)
export const WATER_LITERS_PER_KWH = 1.8;

// CO2 intensity: grams per kWh consumed
// Source: US EPA eGRID 2022 national average (~386 g CO2e/kWh)
export const CO2_GRAMS_PER_KWH = 386;
