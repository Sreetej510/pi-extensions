export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type ListResult =
  | { action: "close" }
  | { action: "paste"; index: number }
  | { action: "edit"; index: number }
  | { action: "delete"; index: number }
  | { action: "add" };
