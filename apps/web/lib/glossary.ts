/**
 * Plain-language copy for readers who are not transport planners, sustainability
 * specialists or from Delhi. Every definition restates what the code and
 * ATTRIBUTION.md already say; nothing here adds a claim of its own.
 */

import type { Evidence } from "@propus/contract";

export const EVIDENCE_MEANING: Record<Evidence, string> = {
  Observed: "Taken directly from a source dataset, such as a stop count in the timetable feed.",
  Calculated: "Arithmetic on observed data, such as a density, a score or a share.",
  Estimated: "Approximated, such as a population share split across areas or a satellite reading.",
  Modelled: "A what-if scenario. It is not a measurement.",
};

export const GLOSSARY: { term: string; meaning: string }[] = [
  {
    term: "Ward",
    meaning:
      "A local administrative area of Delhi, run by the Municipal Corporation of Delhi (MCD). Think of it as a neighbourhood.",
  },
  {
    term: "Transit access score",
    meaning:
      "A score for each ward; higher means better served. It mixes how dense the stops are (35%), how often buses and trains come at peak hours (25%), how many routes serve the ward (20%) and whether a metro station is within 1 km (20%).",
  },
  {
    term: "Catchment / walk radius",
    meaning:
      "The area within a straight-line distance of a stop. The defaults are 500 m for a bus stop and 800 m for a metro station, roughly a 6 to 10 minute walk.",
  },
  {
    term: "Trips per day",
    meaning:
      "How many trips the published timetable schedules at a stop. It counts scheduled services, not passengers.",
  },
  {
    term: "Surface temperature",
    meaning:
      "How hot the ground, roads and roofs are, measured by Landsat satellites in April to June of 2023 to 2025. It is not the air temperature you feel, but it is a fair way to compare places.",
  },
];

export const LIMITS: string[] = [
  "Distances are straight lines, not walking routes.",
  "Trips come from the timetable, not from ridership counts.",
  "Heat is land surface temperature, a relative indicator and not air temperature.",
  "Coverage is Delhi only.",
];

export const SOURCES =
  "Delhi Open Transit Data (buses), DMRC (metro), OpenStreetMap, OpenCity / DataMeet (ward boundaries), WorldPop (population), Landsat via Google Earth Engine (surface temperature).";
