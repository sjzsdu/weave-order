import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ItemStatus } from "@weave-order/schema";

const Payload = z
  .object({
    purpose: z.literal("item-transition-undo"),
    tenantId: z.string(),
    itemId: z.string(),
    actorId: z.string(),
    transitionId: z.string(),
    from: ItemStatus,
    to: ItemStatus,
    currentStage: z.string().nullable(),
    nextAction: z.string().nullable(),
    updatedAt: z.string(),
    exp: z.number().finite(),
  })
  .strict();
export type ItemTransitionPayload = z.infer<typeof Payload>;

export function createItemTransitionToken(secret: string, payload: ItemTransitionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyItemTransitionToken(secret: string, token: string): ItemTransitionPayload {
  const parts = token.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) throw new Error("TOKEN_MALFORMED");
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("TOKEN_SIGNATURE_INVALID");
  }
  const payload = Payload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  if (payload.exp <= Date.now()) throw new Error("TOKEN_EXPIRED");
  return payload;
}
