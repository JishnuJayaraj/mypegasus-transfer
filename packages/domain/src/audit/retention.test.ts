import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditEvent } from "./events";
import { auditDetailClassification, auditDetailKeysByEvent } from "./retention";

function keysOf(schema: unknown): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, value]) => [
      key,
      ...keysOf(value as z.ZodType),
    ]);
  }
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => keysOf(option));
  if (schema instanceof z.ZodArray) return keysOf(schema.element);
  if (schema instanceof z.ZodRecord) {
    if (!(schema.keyType instanceof z.ZodEnum)) throw new Error("audit_record_keys_unclassified");
    return [...schema.keyType.options.map(String), ...keysOf(schema.valueType)];
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return keysOf(schema.unwrap());
  if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodUUID ||
    schema instanceof z.ZodISODateTime ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodLiteral ||
    schema instanceof z.ZodEnum
  )
    return [];
  throw new Error("audit_detail_schema_unclassified");
}

describe("audit detail retention classification", () => {
  it("classifies every detail key of every audit event", () => {
    const missing: string[] = [];
    for (const event of AuditEvent.options) {
      const detail = event.shape.details;
      const keys = [...new Set(keysOf(detail))].toSorted();
      expect(auditDetailKeysByEvent[event.shape.type.value].toSorted()).toEqual(keys);
      for (const key of keys) {
        if (!auditDetailClassification[key]) missing.push(`${event.shape.type.value}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("distinguishes subject records from staff and project references", () => {
    expect(auditDetailClassification.documentId).toBe("subject_record");
    expect(auditDetailClassification.channelIds).toBe("subject_record");
    expect(auditDetailClassification.staffUserId).toBe("staff");
    expect(auditDetailClassification.appointmentId).toBe("reference");
  });
});
