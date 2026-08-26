"use client";

import {
  commitStaged,
  discardFiles,
  getFileDiff,
  getWorkingTreeStatus,
  stageFiles,
  unstageFiles,
} from "@/lib/git/source-control-actions";
import type { SourceControlApi } from "./source-control-contract";

/**
 * The panel's one link to the server.
 *
 * Every component and hook below takes a `SourceControlApi` as a value, and
 * this module is the only place the real server actions are named. That is
 * what lets the panel be rendered in a test — or in a screenshot harness —
 * with a fake git behind it, and it means a change to where those actions live
 * is a change to one import in one file.
 */
export const sourceControlApi: SourceControlApi = {
  getWorkingTreeStatus,
  stageFiles,
  unstageFiles,
  discardFiles,
  commitStaged,
  getFileDiff,
};
