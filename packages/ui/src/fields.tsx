import { DatePicker, DatePickerInput } from "@carbon/react";
import type { ChangeEvent } from "react";

interface DateFieldProps {
  id: string;
  labelText: string;
  onChange: (text: string) => void;
  defaultValue?: string;
  invalidText?: string;
}

/**
 * A `TT.MM.JJJJ` text field: Carbon's simple DatePicker, without the calendar widget. The raw
 * text goes to `parseDisplayDate`, so an impossible date like `31.02.2027` is reported as an
 * error instead of being interpreted by the calendar's own date parsing.
 */
export function DateField({ id, labelText, onChange, defaultValue, invalidText }: DateFieldProps) {
  return (
    <DatePicker datePickerType="simple">
      <DatePickerInput
        id={id}
        labelText={labelText}
        placeholder="TT.MM.JJJJ"
        defaultValue={defaultValue}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        invalid={invalidText !== undefined}
        invalidText={invalidText}
      />
    </DatePicker>
  );
}
