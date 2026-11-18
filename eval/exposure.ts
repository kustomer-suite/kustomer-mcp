import type { Fixture } from "../conformance/fake-api.js";

// What an agent was SHOWN, whatever it then did with it: model-independent. A
// token that can read tool-call logs through raw REST sees the store tool's
// password and endpoint; through the server it cannot.
export type Exposure = Record<"storeToolSecret" | "storeToolEndpoint" | "phone" | "email" | "otherStore", boolean>;

export function exposure(outputs: string[], fx: Fixture): Exposure {
  const all = outputs.join("\n");
  const has = (...needles: string[]) => needles.some((n) => all.includes(n));
  return {
    storeToolSecret: has(fx.markers.password),
    storeToolEndpoint: has("hotel.example"),
    phone: has(fx.markers.phone, "6281234567890"),
    email: has(fx.markers.email, "reservasi@example.com"),
    otherStore: has(fx.markers.otherStore),
  };
}

export const anyExposure = (e: Exposure) => Object.values(e).some(Boolean);
