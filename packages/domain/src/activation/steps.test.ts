import { describe, expect, it } from "vitest";
import {
  identityAssurance,
  needsBirthDate,
  nextActivationStep,
  stepRefusal,
  type ActivationProgress,
} from "./steps";

const start = (change: Partial<ActivationProgress> = {}): ActivationProgress => ({
  channel: "letter",
  hasBirthDate: true,
  birthDateChecked: false,
  deliveryAddressChecked: false,
  oneTimeCodeSent: false,
  ...change,
});

describe("the activation steps (D23, Q129)", () => {
  it.each([
    ["letter", true, true],
    ["letter", false, true],
    ["sheet", true, true],
    ["sheet", false, false],
    ["in_person", true, true],
    ["in_person", false, false],
  ] as const)("%s with birth date %s asks for it: %s", (channel, hasBirthDate, expected) => {
    expect(needsBirthDate(channel, hasBirthDate)).toBe(expected);
  });

  it("walks a letter through birth date, channel and one-time code", () => {
    expect(nextActivationStep(start())).toBe("birth_date");
    expect(nextActivationStep(start({ birthDateChecked: true }))).toBe("channel");
    expect(nextActivationStep(start({ birthDateChecked: true, oneTimeCodeSent: true }))).toBe(
      "one_time_code",
    );
  });

  it("walks an in-person code through birth date and the delivery address", () => {
    const inPerson = start({ channel: "in_person" });
    expect(nextActivationStep(inPerson)).toBe("birth_date");
    expect(nextActivationStep({ ...inPerson, birthDateChecked: true })).toBe("delivery_address");
    expect(
      nextActivationStep({ ...inPerson, birthDateChecked: true, deliveryAddressChecked: true }),
    ).toBe("complete");
  });

  it("skips the birth date only for a sheet or in-person code without one", () => {
    expect(nextActivationStep(start({ channel: "sheet", hasBirthDate: false }))).toBe("channel");
    expect(nextActivationStep(start({ channel: "in_person", hasBirthDate: false }))).toBe(
      "delivery_address",
    );
  });

  it("allows each request only at its step; a new one-time code may be requested again", () => {
    expect(stepRefusal(start(), "birth_date")).toBeNull();
    expect(stepRefusal(start(), "channel")).toBe("step_not_allowed");
    expect(stepRefusal(start(), "complete")).toBe("step_not_allowed");
    expect(stepRefusal(start({ birthDateChecked: true }), "birth_date")).toBe("step_not_allowed");
    const sent = start({ birthDateChecked: true, oneTimeCodeSent: true });
    expect(stepRefusal(sent, "channel")).toBeNull();
    expect(stepRefusal(sent, "complete")).toBeNull();
    expect(stepRefusal(sent, "delivery_address")).toBe("step_not_allowed");
    const inPerson = start({ channel: "in_person", hasBirthDate: false });
    expect(stepRefusal(inPerson, "delivery_address")).toBeNull();
    expect(stepRefusal(inPerson, "channel")).toBe("step_not_allowed");
    expect(stepRefusal(inPerson, "complete")).toBe("step_not_allowed");
    expect(stepRefusal({ ...inPerson, deliveryAddressChecked: true }, "complete")).toBeNull();
    expect(stepRefusal({ ...inPerson, deliveryAddressChecked: true }, "delivery_address")).toBe(
      "step_not_allowed",
    );
  });

  it("records photo-ID assurance only when the birth-date step was skipped (D29)", () => {
    expect(identityAssurance(start({ birthDateChecked: true }))).toBe("birth_date");
    expect(identityAssurance(start({ channel: "sheet", hasBirthDate: false }))).toBe("photo_id");
  });
});
