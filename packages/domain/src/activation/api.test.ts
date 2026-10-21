import { describe, expect, it } from "vitest";
import { BatchActivationCodeInput } from "./api";

describe("batch activation-code input", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("refuses the same participation twice", () => {
    const result = BatchActivationCodeInput.safeParse({
      participationIds: [id, id],
      channel: "letter",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["participationIds"],
      params: { code: "duplicate" },
    });
    expect(
      BatchActivationCodeInput.parse({ participationIds: [id], channel: "sheet" }),
    ).toMatchObject({ language: "de", replaceOpenCode: false });
  });
});
