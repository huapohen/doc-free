"use strict";

// Structural contracts shared by MCP and autonomous plans. Calendar reducers
// remain authoritative for timezone, recurrence and occurrence semantics.
const text = (maxLength) => ({ type: "string", ...(maxLength ? { maxLength } : {}) });
const date = { ...text(10), pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const weekday = { type: "integer", minimum: 1, maximum: 7 };
const recurrenceSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["frequency"],
  properties: {
    frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: "integer", minimum: 1, maximum: 999, default: 1 },
    weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: weekday },
    month_day: { type: "integer", enum: [-1, ...Array.from({ length: 31 }, (_, i) => i + 1)] },
    ordinal_weekday: { type: "object", additionalProperties: false, required: ["ordinal", "weekday"],
      properties: { ordinal: { type: "integer", enum: [-1, 1, 2, 3, 4, 5] }, weekday } },
    month: { type: "integer", minimum: 1, maximum: 12 },
    count: { type: "integer", minimum: 1, maximum: 10000 },
    until_date: date,
  },
};
const scheduleFields = {
  title: text(200), description: text(8000), location: text(300),
  starts_at: text(80), ends_at: text(80), all_day: { type: "boolean" },
  timezone: text(100), start_date: date, end_date: date, recurrence: recurrenceSchema,
  attendee_ids: { type: "array", maxItems: 100, items: text(100) },
};
const mutationFields = {
  base_revision: { type: "integer", minimum: 1 },
  client_id: { ...text(160), minLength: 1 },
  scope: { type: "string", enum: ["series", "occurrence"] },
  occurrence_id: { type: "string", minLength: 1, maxLength: 256 },
};
const createTimeAlternatives = [
  { required: ['starts_at', 'ends_at'], properties: { all_day: { const: false } } },
  { required: ['all_day', 'start_date', 'end_date'], properties: { all_day: { const: true } } },
];

function validCalendarField(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type) && !(types.includes("integer") && Number.isSafeInteger(value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (value === null) return true;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (schema.minimum !== undefined && value < schema.minimum ||
      schema.maximum !== undefined && value > schema.maximum)) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems ||
        schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value).size !== value.length) return false;
    return value.every((item) => validCalendarField(item, schema.items));
  }
  if (type === "object") {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !schema.properties?.[key] || validCalendarField(item, schema.properties[key]));
  }
  return true;
}

module.exports = { recurrenceSchema, scheduleFields, mutationFields, createTimeAlternatives, validCalendarField };
