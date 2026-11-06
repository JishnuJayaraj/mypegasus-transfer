import { screen } from "@testing-library/react";
import {
  AppointmentStatus,
  DeadlineState,
  DsvStatus,
  LifecycleFlag,
  MainStatus,
  ProfilingStatus,
} from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { StatusTag, statusCodes, statusTag } from "./status";
import { renderUi } from "./test-utils";

describe("the status map", () => {
  it("covers every code of every family the domain has", () => {
    expect(statusCodes.main.toSorted()).toEqual(MainStatus.options.toSorted());
    expect(statusCodes.profiling.toSorted()).toEqual(ProfilingStatus.options.toSorted());
    expect(statusCodes.dsv.toSorted()).toEqual(DsvStatus.options.toSorted());
    expect(statusCodes.deadline.toSorted()).toEqual(DeadlineState.options.toSorted());
    expect(statusCodes.flag.toSorted()).toEqual(LifecycleFlag.options.toSorted());
    expect(statusCodes.appointment.toSorted()).toEqual(AppointmentStatus.options.toSorted());
  });

  it("follows the colour language: overdue red, due soon yellow, done green, terminal gray", () => {
    expect(statusTag("deadline", "overdue")).toMatchObject({ tone: "danger", type: "red" });
    expect(statusTag("deadline", "upcoming")).toMatchObject({ tone: "warning" });
    expect(statusTag("dsv", "dsv_signed")).toMatchObject({ tone: "success", type: "green" });
    expect(statusTag("profiling", "profiling_in_progress")).toMatchObject({ type: "blue" });
    expect(statusTag("main", "withdrawn")).toMatchObject({ tone: "neutral", type: "gray" });
    expect(statusTag("flag", "tg_start_missed").tone).toBe("danger");
  });

  it("gives each tone its own icon, so colour is never the only signal", () => {
    const tags = (Object.keys(statusCodes) as (keyof typeof statusCodes)[]).flatMap((family) =>
      statusCodes[family].map((code) => statusTag(family, code as never)),
    );
    const iconOf = new Map(tags.map((tag) => [tag.tone, tag.icon]));
    expect(iconOf.size).toBe(5);
    expect(new Set(iconOf.values()).size).toBe(5);
    for (const tag of tags) expect(tag.icon).toBe(iconOf.get(tag.tone));
  });

  it("names each label key after the app catalog's family", () => {
    expect(statusTag("main", "informed").labelKey).toBe("participants.statuses.informed");
    expect(statusTag("flag", "dsv_never_offered").labelKey).toBe(
      "worklist.flags.dsv_never_offered",
    );
  });
});

describe("StatusTag", () => {
  it("shows the label as text with a decorative icon", () => {
    renderUi(<StatusTag family="deadline" code="overdue" />);
    const tag = screen.getByText("Überschritten").closest(".cds--tag")!;
    expect(tag).toHaveAttribute("data-tone", "danger");
    expect(tag.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
