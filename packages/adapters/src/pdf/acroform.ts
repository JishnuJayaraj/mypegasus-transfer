import fontkit from "@pdf-lib/fontkit";
import type { FieldMap, FilledField, TextMeasure } from "@transfer/domain";
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFTextField,
  type PDFFont,
  type PDFForm,
} from "pdf-lib";
import { FormFillRefused } from "./pdf-renderer";

// pdf-lib's AcroForm filling (ba-forms.md, the registry): text in the embedded font at the
// layout's size, radios and checkboxes by the export value or on-state the field map names.

const filledKinds: Record<string, FilledField["kind"]> = {
  text: "text",
  date: "text",
  time: "text",
  radio: "radio",
  checkbox: "checkbox",
  checkbox_choice: "checkbox_choice",
};

/** The fillable fields of a map and the kind a filled value must have; never-filled ones absent. */
function fillable(map: FieldMap): Map<string, FilledField["kind"]> {
  const kinds = new Map<string, FilledField["kind"]>();
  for (const entry of map.entries) {
    const columns = entry.kind === "table" ? entry.columns : [entry];
    for (const column of columns) {
      for (const name of column.fields) kinds.set(name, filledKinds[column.kind]!);
    }
  }
  return kinds;
}

async function embed(doc: PDFDocument, font: Uint8Array): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  // The committed file is already a subset; embedding it whole keeps every glyph available.
  return doc.embedFont(font, { subset: false });
}

/**
 * Flattening deletes the widgets, but references to them stay: in a page's `Annots` and, the BA
 * forms being tagged PDFs, in the structure tree (`OBJR`). A reference to a missing object
 * reads as null, yet strict readers report an invalid cross-reference, so this removes each such
 * reference and each `OBJR` whose object is gone; nothing else changes.
 */
function dropDanglingReferences(doc: PDFDocument): void {
  const missing = (value: unknown) => value instanceof PDFRef && !doc.context.lookup(value);
  const gone = (value: unknown): boolean => {
    if (missing(value)) return true;
    const target = value instanceof PDFRef ? doc.context.lookup(value) : value;
    return (
      target instanceof PDFDict &&
      target.get(PDFName.of("Type")) === PDFName.of("OBJR") &&
      missing(target.get(PDFName.of("Obj")))
    );
  };
  const clean = (value: unknown): void => {
    if (value instanceof PDFArray) {
      for (let index = value.size() - 1; index >= 0; index--) {
        if (gone(value.get(index))) value.remove(index);
        else clean(value.get(index));
      }
    } else if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (gone(entry)) value.delete(key);
        else clean(entry);
      }
    } else if (value instanceof PDFStream) {
      clean(value.dict);
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) clean(object);
}

/** Deletes the objects flattening orphaned (no longer reachable from the trailer). */
function dropUnreachableObjects(doc: PDFDocument): void {
  const reached = new Set<PDFRef>();
  const visit = (value: unknown): void => {
    if (value instanceof PDFRef) {
      if (reached.has(value)) return;
      reached.add(value);
      visit(doc.context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) visit(entry);
    } else if (value instanceof PDFArray) {
      for (const entry of value.asArray()) visit(entry);
    } else if (value instanceof PDFStream) {
      visit(value.dict);
    }
  };
  visit(doc.context.trailerInfo.Root);
  visit(doc.context.trailerInfo.Info);
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) doc.context.delete(ref);
  }
}

/** Flattening draws each widget's appearance; a field without one (Kug 200a) gets it drawn. */
function ensureAppearances(form: PDFForm, font: PDFFont): void {
  for (const field of form.getFields()) {
    const missing = field.acroField
      .getWidgets()
      .some((widget) => widget.getAppearances()?.normal === undefined);
    if (!missing) continue;
    if (field instanceof PDFTextField) field.updateAppearances(font);
    else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)
      field.updateAppearances();
  }
}

const sized = (appearance: string, size: number) =>
  appearance.replace(/(\/\S+\s+)[0-9.]+(\s+Tf)/, `$1${size}$2`);

/**
 * The layout's size on the field's `DA` and on every widget's own `DA`, which pdf-lib reads
 * first (the Kug 200a's header fields have only widget ones).
 */
function setFontSize(text: PDFTextField, size: number): void {
  const own = text.acroField.getDefaultAppearance();
  if (own !== undefined) text.acroField.setDefaultAppearance(sized(own, size));
  for (const widget of text.acroField.getWidgets()) {
    const appearance = widget.getDefaultAppearance();
    if (appearance !== undefined) widget.setDefaultAppearance(sized(appearance, size));
  }
}

export async function fillAcroForm(
  font: Uint8Array,
  input: {
    template: Uint8Array;
    fieldMap: FieldMap;
    fields: readonly FilledField[];
    flatten?: boolean;
  },
): Promise<Uint8Array> {
  const kinds = fillable(input.fieldMap);
  for (const field of input.fields) {
    if (kinds.get(field.name) !== field.kind) throw new FormFillRefused(field.name);
  }
  const doc = await PDFDocument.load(input.template, { updateMetadata: false });
  const embedded = await embed(doc, font);
  const form = doc.getForm();
  for (const field of input.fields) {
    switch (field.kind) {
      case "text": {
        const text = form.getTextField(field.name);
        setFontSize(text, field.fontSize);
        text.setText(field.value);
        text.updateAppearances(embedded);
        break;
      }
      case "radio":
        form.getRadioGroup(field.name).select(field.value);
        break;
      case "checkbox":
        form.getCheckBox(field.name).check();
        break;
      case "checkbox_choice": {
        // One widget's on-state, the others off (pdf-lib's `check` knows only the first widget).
        const box = form.getCheckBox(field.name);
        const widgets = box.acroField.getWidgets();
        const on = widgets.find((widget) => widget.getOnValue()?.decodeText() === field.value);
        if (!on) throw new FormFillRefused(field.name);
        box.acroField.dict.set(PDFName.of("V"), on.getOnValue()!);
        for (const widget of widgets) {
          widget.setAppearanceState(widget === on ? on.getOnValue()! : PDFName.of("Off"));
        }
        break;
      }
    }
  }
  if (input.flatten ?? true) {
    ensureAppearances(form, embedded);
    form.flatten({ updateFieldAppearances: false });
    // Fonts are written at flush; before it their references would read as missing.
    await doc.flush();
    dropUnreachableObjects(doc);
    dropDanglingReferences(doc);
  }
  return doc.save({ updateFieldAppearances: false });
}

/** Every field's value: text, the selected export value, a checkbox's on-state or null. */
export async function readAcroFormValues(pdf: Uint8Array): Promise<Record<string, string | null>> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const values: Record<string, string | null> = {};
  for (const field of doc.getForm().getFields()) {
    let value: string | null = null;
    if (field instanceof PDFTextField) value = field.getText() ?? null;
    else if (field instanceof PDFRadioGroup) value = field.getSelected() ?? null;
    else if (field instanceof PDFCheckBox) {
      const state = field.acroField.dict.lookup(PDFName.of("V"));
      value = state instanceof PDFName && state !== PDFName.of("Off") ? state.decodeText() : null;
    }
    values[field.getName()] = value;
  }
  return values;
}

/** The embedded font's metrics as pdf-lib computes them, for `layoutForm`. */
export async function createTextMeasure(font: Uint8Array): Promise<TextMeasure> {
  const embedded = await embed(await PDFDocument.create(), font);
  return {
    widthOf: (text, size) => embedded.widthOfTextAtSize(text, size),
    heightAt: (size) => embedded.heightAtSize(size),
  };
}

export async function pageCount(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
}
