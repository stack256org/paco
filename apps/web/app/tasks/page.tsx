import type { Metadata } from "next";
import { TaskBoard } from "./task-board";

export const metadata: Metadata = {
  title: "Tasks",
  description: "The organisation's task board.",
};

export default function TasksPage() {
  return <TaskBoard />;
}
