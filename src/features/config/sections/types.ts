import type { GlobalConfig } from "@/lib/config/schemas";
import type { FieldPath } from "../form-state";

export interface ConfigFormController {
  formState: GlobalConfig;
  formRevision: number;
  handleChange(path: FieldPath, value: unknown): void;
  handleChangeMulti(changes: Array<[FieldPath, unknown]>): void;
  isDefault(path: FieldPath): boolean;
  isModified(path: FieldPath): boolean;
  handleValidityChange(path: FieldPath, valid: boolean): void;
}
