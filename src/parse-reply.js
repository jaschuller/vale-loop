"use strict";

const STOP_PHRASES = ["vale's done", "go dark"];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'");
}

function containsStop(text) {
  const t = normalize(text);
  return STOP_PHRASES.some((phrase) => t.includes(phrase));
}

function looksLikeLimit(text) {
  const t = normalize(text);
  if (!t) return false;
  if (t.includes("try again later")) return true;
  if (/\bmaxed\b/.test(t)) return true;
  if (/\b(usage|rate)[-\s]?limit/.test(t)) return true;
  if (/\b(hit|reached|over|exceeded|weekly|daily)\b.{0,40}\b(usage|limit)\b/.test(t)) {
    return true;
  }
  if (/\b(usage|limit)\b.{0,40}\b(hit|reached|over|exceeded|weekly|daily)\b/.test(t)) {
    return true;
  }
  return false;
}

module.exports = { containsStop, looksLikeLimit };
