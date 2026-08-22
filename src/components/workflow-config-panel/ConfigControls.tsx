"use client";

import { MultilineInput } from "@/components/MultilineInput";
import { CheckboxField } from "@/components/ui/Checkbox";
import { cn } from "@/lib/ui/cn";
import {
  ChevronRightIcon,
  CloseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import { navigationTriggerId } from "./navigation-ids";
import { ConfigValueParts, type ConfigValuePart } from "./value-parts";

/**
 * The controls a config row hosts that no shared primitive already covers.
 *
 * Switch, SegmentedControl, Select and the numeric input compose directly from
 * `@/components/ui` and `workflow-config/FieldPrimitives`, and the wide
 * segmented variant is `layoutClassName="w-full"` on the same primitive — none
 * of them needs a wrapper here.
 */

const FIELD_BOX =
  "rounded-sm border border-solid border-border-default bg-bg-surface font-mono text-text-primary transition-[border-color] duration-150 outline-none " +
  "focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-55 max-768:min-h-[44px]";

/** The panel's button geometry; callers add height, padding and tone. */
export const CONFIG_BUTTON_BOX =
  "inline-flex cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-solid border-border-default bg-bg-raised font-mono text-[0.72rem] font-medium text-text-secondary " +
  "hover:enabled:border-border-strong hover:enabled:bg-bg-elevated hover:enabled:text-text-primary " +
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] " +
  "disabled:cursor-not-allowed disabled:opacity-50 max-768:min-h-[44px] max-768:min-w-[44px]";

/**
 * A removable value reads as a pill. Below the breakpoint its remove control is
 * a 44px touch target, and the pill grows with it rather than clipping it —
 * pills wrap in a gapped row, so a hit area spilling outside the pill would be
 * stealing the neighbouring pill's taps.
 */
export const CHIP_PILL =
  "inline-flex items-center gap-[4px] rounded-full border border-solid border-border-subtle bg-bg-raised py-[1px] pr-[3px] pl-[9px] font-mono text-[0.72rem] text-text-primary max-768:min-h-[44px] max-768:py-0 max-768:pr-0";

export const CHIP_REMOVE =
  "inline-flex size-[18px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-text-tertiary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:1px] max-768:size-[44px]";

/** The 22px square variant every in-row affordance uses. */
export const CONFIG_ICON_BUTTON_BOX = cn(
  CONFIG_BUTTON_BOX,
  "size-[22px] flex-shrink-0 p-0 max-768:size-[44px]",
);

export function ConfigTextInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
  onBlur,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * For fields that hold raw draft text while focused and settle to their
   * canonical rendering once editing ends — the enum options list is the one
   * such field today.
   */
  onBlur?: () => void;
}): React.JSX.Element {
  return (
    <input
      type="text"
      className={cn(FIELD_BOX, "w-[158px] px-[10px] py-[5px] text-[0.72rem]")}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
    />
  );
}

export function ConfigTextArea({
  value,
  onChange,
  ariaLabel,
  rows = 3,
  placeholder,
  disabled,
  monospaceDense = false,
  onPrimaryAction,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** The tighter type the JSON schema editor reads better in. */
  monospaceDense?: boolean;
  /**
   * Submit from the editor itself — the Cmd/Ctrl+Enter shortcut, and the value
   * a dictation delivers when it is stopped and submitted. It receives the
   * NEXT value rather than reading state, because a stop-and-submit arrives
   * with text the change handler has not seen yet.
   */
  onPrimaryAction?: (next: string) => void;
}): React.JSX.Element {
  // Every multiline editor in the app goes through the shared native adapter,
  // so the panel's textareas inherit its shortcut and voice behaviour rather
  // than being a second, quieter kind of text entry.
  return (
    <MultilineInput
      className={cn(
        FIELD_BOX,
        "box-border w-full resize-y px-[10px] py-[7px] leading-[1.5]",
        monospaceDense ? "text-[0.72rem] leading-[1.6]" : "text-[0.74rem]",
      )}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onValueChange={onChange}
      {...(onPrimaryAction === undefined ? {} : { onPrimaryAction })}
    />
  );
}

export interface ConfigEditableChip {
  id: string;
  label: string;
  onRemove: () => void;
}

export function ConfigChipsEditor({
  chips,
  addLabel,
  onAdd,
  disabled,
}: {
  chips: readonly ConfigEditableChip[];
  addLabel: string;
  onAdd: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-[5px]">
      {chips.map((chip) => (
        <span key={chip.id} className={CHIP_PILL}>
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            disabled={disabled}
            aria-label={`Remove ${chip.label}`}
            className={cn(
              CHIP_REMOVE,
              "hover:enabled:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        className={cn(
          CONFIG_BUTTON_BOX,
          "h-[24px] rounded-full border-dashed px-[10px]",
        )}
      >
        <PlusIcon size={11} />
        {addLabel}
      </button>
    </div>
  );
}

export interface ConfigChecklistOption {
  id: string;
  label: string;
  description?: string;
  /**
   * Accessible name when the visible label is not self-sufficient — several
   * charter sources each list the same context ids, so "ctx_checkout" alone
   * would name a dozen different checkboxes identically.
   */
  ariaLabel?: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}

export function ConfigChecklist({
  options,
  disabled,
}: {
  options: readonly ConfigChecklistOption[];
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[7px] pt-[2px]">
      {options.map((option) => (
        <CheckboxField
          key={option.id}
          // §12: these options are tapped on the two workflow pages, so the box
          // takes the 44px pointer target the primitive offers.
          touch
          label={option.label}
          description={option.description}
          {...(option.ariaLabel === undefined
            ? {}
            : { "aria-label": option.ariaLabel })}
          checked={option.checked}
          disabled={disabled}
          onCheckedChange={(next) => option.onToggle(next === true)}
        />
      ))}
    </div>
  );
}

export interface ConfigListItem {
  id: string;
  title: string;
  chips?: readonly ConfigValuePart[];
  /** Secondary line under the title. */
  meta?: string;
  /** Set together with `onOpen` to make the title drill into a child screen. */
  screenId?: string;
  onOpen?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  /**
   * Disables this item's remove alone — the last acceptance criterion cannot
   * go, while its siblings' controls stay live. Kept as a disabled control
   * rather than an absent one so the affordance does not appear and vanish as
   * the list crosses one entry.
   */
  removeDisabled?: boolean;
  /** The item's own editors — screens compose whatever fields they need. */
  children?: React.ReactNode;
}

const ITEM_TITLE =
  "min-w-0 truncate font-mono text-[0.74rem] font-semibold text-text-primary";

export function ConfigItemList({
  items,
  addLabel,
  onAdd,
  disabled,
}: {
  items: readonly ConfigListItem[];
  addLabel?: string;
  onAdd?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm">
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`config-item-${item.id}`}
          className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base px-[10px] py-sm"
        >
          <div className="flex items-center gap-[7px]">
            {item.onOpen && item.screenId ? (
              <button
                type="button"
                id={navigationTriggerId(item.screenId)}
                onClick={item.onOpen}
                // §12: a list row that drills is panel navigation, so below the
                // breakpoint it is a touch target like the root cards it sits
                // among.
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] max-768:min-h-[44px]"
              >
                <span className={ITEM_TITLE}>{item.title}</span>
                {item.chips ? <ConfigValueParts parts={item.chips} /> : null}
                <span className="ml-auto flex flex-shrink-0 text-text-tertiary">
                  <ChevronRightIcon size={12} />
                </span>
              </button>
            ) : (
              <>
                <span className={ITEM_TITLE}>{item.title}</span>
                {item.chips ? <ConfigValueParts parts={item.chips} /> : null}
              </>
            )}
            {item.onMoveUp || item.onMoveDown || item.onRemove ? (
              <div className="ml-auto flex flex-shrink-0 items-center gap-[4px]">
                {item.onMoveUp ? (
                  <button
                    type="button"
                    onClick={item.onMoveUp}
                    disabled={disabled}
                    aria-label={`Move ${item.title} up`}
                    className={CONFIG_ICON_BUTTON_BOX}
                  >
                    <ArrowUpIcon size={11} />
                  </button>
                ) : null}
                {item.onMoveDown ? (
                  <button
                    type="button"
                    onClick={item.onMoveDown}
                    disabled={disabled}
                    aria-label={`Move ${item.title} down`}
                    className={CONFIG_ICON_BUTTON_BOX}
                  >
                    <ArrowDownIcon size={11} />
                  </button>
                ) : null}
                {item.onRemove ? (
                  <button
                    type="button"
                    onClick={item.onRemove}
                    disabled={disabled || item.removeDisabled}
                    aria-label={`Remove ${item.title}`}
                    className={CONFIG_ICON_BUTTON_BOX}
                  >
                    <CloseIcon size={11} />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {item.meta ? (
            <div className="font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
              {item.meta}
            </div>
          ) : null}
          {item.children}
        </div>
      ))}
      {addLabel && onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className={cn(CONFIG_BUTTON_BOX, "h-[28px] self-start px-[10px]")}
        >
          <PlusIcon size={11} />
          {addLabel}
        </button>
      ) : null}
    </div>
  );
}

export function ConfigDangerButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        CONFIG_BUTTON_BOX,
        "h-[28px] self-start border-red-dim px-[10px] text-red hover:enabled:border-red hover:enabled:bg-red-glow hover:enabled:text-red",
      )}
    >
      <TrashIcon size={12} />
      {label}
    </button>
  );
}
