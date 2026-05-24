import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { FieldPath, WorkflowDefaultsBlock } from "../form-state";

export interface ConfigFormController {
  formState: GlobalConfig;
  handleChange(path: FieldPath, value: unknown): void;
  handleChangeMulti(changes: Array<[FieldPath, unknown]>): void;
  handleChangeBlock<K extends WorkflowDefaultsBlock>(
    block: K,
    value: WorkflowDefaults[K],
  ): void;
  isDefault(path: FieldPath): boolean;
  isModified(path: FieldPath): boolean;
}
