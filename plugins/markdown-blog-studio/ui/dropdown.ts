import { el, svgIcon } from './dom';

export type DropdownTone = 'positive' | 'warning' | 'info' | 'accent' | 'muted';

export interface CustomSelectOption {
  value: string;
  label: string;
  triggerLabel?: string;
  subtitle?: string;
  badge?: string;
  badgeTone?: DropdownTone;
  dotTone?: DropdownTone;
}

export interface CustomSelectConfig {
  ariaLabel: string;
  variant?: 'default' | 'compact' | 'full';
  maxWidth?: string;
  menuMinWidth?: number;
  searchable?: boolean;
  searchThreshold?: number;
  searchPlaceholder?: string;
  placeholder?: string;
  onChange?: (value: string, option: CustomSelectOption) => void;
  onOpenChange?: (open: boolean) => void;
}

export interface CustomSelectHandle {
  el: HTMLDivElement;
  trigger: HTMLButtonElement;
  getValue(): string;
  setValue(value: string): void;
  setOptions(options: CustomSelectOption[], selectedValue?: string): void;
  isOpen(): boolean;
  open(): void;
  close(restoreFocus?: boolean): void;
  focus(): void;
}

interface SelectInstanceRecord {
  root: HTMLDivElement;
  isOpen: () => boolean;
  close: (restoreFocus?: boolean) => void;
}

const activeInstances = new Set<SelectInstanceRecord>();
let idCounter = 0;

export function closeAllCustomSelects(container?: ParentNode | null): boolean {
  let closedAny = false;
  for (const inst of activeInstances) {
    if (container && !container.contains(inst.root)) continue;
    if (inst.isOpen()) {
      inst.close(false);
      closedAny = true;
    }
  }
  return closedAny;
}

export function hasOpenCustomSelectIn(container: ParentNode): boolean {
  for (const inst of activeInstances) {
    if (inst.isOpen() && container.contains(inst.root)) {
      return true;
    }
  }
  return false;
}

export function createCustomSelect(config: CustomSelectConfig): CustomSelectHandle {
  idCounter += 1;
  const listboxId = `custom-select-list-${idCounter}`;

  let options: CustomSelectOption[] = [];
  let filteredOptions: CustomSelectOption[] = [];
  let currentValue = '';
  let openState = false;
  let focusedIndex = -1;

  const variantClass =
    config.variant === 'compact'
      ? ' is-compact'
      : config.variant === 'full'
        ? ' is-full-width'
        : '';

  const root = el('div', {
    className: `custom-select${variantClass}`
  }) as HTMLDivElement;

  if (config.maxWidth) {
    root.style.maxWidth = config.maxWidth;
  }

  const triggerDot = el('span', { className: 'select-status-dot', hidden: true });
  const triggerLabelEl = el('span', {
    className: 'custom-select-label',
    textContent: config.placeholder || 'Select…'
  });
  const triggerChevron = el(
    'span',
    { className: 'custom-select-chevron' },
    svgIcon(['m6 9 6 6 6-6'], 14)
  );

  const trigger = el(
    'button',
    {
      type: 'button',
      className: 'custom-select-trigger',
      role: 'combobox',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': listboxId,
      'aria-label': config.ariaLabel
    },
    triggerDot,
    triggerLabelEl,
    triggerChevron
  ) as HTMLButtonElement;

  const searchInput = el('input', {
    type: 'search',
    className: 'custom-select-search',
    placeholder: config.searchPlaceholder || 'Filter…',
    'aria-label': `Filter ${config.ariaLabel}`
  }) as HTMLInputElement;

  const searchWrap = el(
    'div',
    { className: 'custom-select-search-wrap', hidden: true },
    searchInput
  );

  const listEl = el('div', {
    id: listboxId,
    className: 'custom-select-list',
    role: 'listbox',
    'aria-label': config.ariaLabel
  }) as HTMLDivElement;

  const emptyEl = el('div', {
    className: 'custom-select-empty',
    textContent: 'No matching items',
    hidden: true
  }) as HTMLDivElement;

  const menuEl = el(
    'div',
    { className: 'custom-select-menu', hidden: true },
    searchWrap,
    listEl,
    emptyEl
  ) as HTMLDivElement;

  root.append(trigger, menuEl);

  function getOptionByValue(value: string): CustomSelectOption | undefined {
    return options.find((opt) => opt.value === value);
  }

  function updateTriggerDisplay(): void {
    const selected = getOptionByValue(currentValue);
    const displayText = selected ? selected.triggerLabel || selected.label : config.placeholder || 'Select…';
    triggerLabelEl.textContent = displayText;
    trigger.title = selected ? selected.label : displayText;

    if (selected?.dotTone) {
      triggerDot.className = `select-status-dot tone-${selected.dotTone}`;
      triggerDot.hidden = false;
    } else {
      triggerDot.className = 'select-status-dot';
      triggerDot.hidden = true;
    }
  }

  function syncFocusHighlight(): void {
    const optionButtons = listEl.querySelectorAll<HTMLButtonElement>('.custom-select-option');
    optionButtons.forEach((btn, idx) => {
      const active = idx === focusedIndex;
      btn.classList.toggle('is-focused', active);
      if (active) {
        btn.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function commitSelection(opt: CustomSelectOption): void {
    const changed = opt.value !== currentValue;
    currentValue = opt.value;
    updateTriggerDisplay();
    renderOptionsList();
    close(true);
    if (changed) {
      config.onChange?.(opt.value, opt);
    }
  }

  function renderOptionsList(): void {
    const query = searchInput.value.trim().toLowerCase();
    filteredOptions = query
      ? options.filter((opt) => {
          const hay = `${opt.label} ${opt.subtitle || ''} ${opt.badge || ''}`.toLowerCase();
          return hay.includes(query);
        })
      : [...options];

    const optionNodes = filteredOptions.map((opt, idx) => {
      const isSelected = opt.value === currentValue;
      const dotNode = opt.dotTone
        ? el('span', { className: `select-status-dot tone-${opt.dotTone}` })
        : null;

      const textStack = el(
        'span',
        { className: 'custom-select-option-text' },
        el('span', { className: 'custom-select-option-label', textContent: opt.label }),
        opt.subtitle ? el('span', { className: 'custom-select-option-sub', textContent: opt.subtitle }) : null
      );

      const badgeNode = opt.badge
        ? el('span', {
            className: `custom-select-option-badge tone-${opt.badgeTone || 'muted'}`,
            textContent: opt.badge
          })
        : null;

      const checkNode = el(
        'span',
        { className: 'custom-select-option-check', hidden: !isSelected },
        svgIcon(['M20 6 9 17l-5-5'], 14)
      );

      const metaGroup =
        badgeNode || isSelected
          ? el('span', { className: 'custom-select-option-meta' }, badgeNode, checkNode)
          : null;

      const optionBtn = el(
        'button',
        {
          type: 'button',
          className: `custom-select-option${idx === focusedIndex ? ' is-focused' : ''}`,
          role: 'option',
          tabindex: '-1',
          'aria-selected': String(isSelected),
          'data-value': opt.value
        },
        dotNode,
        textStack,
        metaGroup
      ) as HTMLButtonElement;

      optionBtn.addEventListener('pointerenter', () => {
        focusedIndex = idx;
        syncFocusHighlight();
      });

      optionBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });

      optionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        commitSelection(opt);
      });

      return optionBtn;
    });

    listEl.replaceChildren(...optionNodes);
    emptyEl.hidden = filteredOptions.length > 0;
  }

  function positionMenu(): void {
    const rect = trigger.getBoundingClientRect();
    const desiredMin = config.menuMinWidth ? Math.min(config.menuMinWidth, window.innerWidth - 24) : 0;
    menuEl.style.minWidth = desiredMin > 0 ? `${desiredMin}px` : '';

    const measuredWidth = Math.max(rect.width, desiredMin, menuEl.offsetWidth || 0);
    const spaceRight = window.innerWidth - rect.left - 12;
    const spaceLeft = rect.right - 12;
    const alignRight = measuredWidth > spaceRight && spaceLeft >= spaceRight;
    menuEl.classList.toggle('align-right', alignRight);

    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    menuEl.classList.toggle('open-up', openUp);
  }

  function open(): void {
    if (openState) return;
    closeAllCustomSelects();

    openState = true;
    root.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');

    const threshold = config.searchThreshold ?? 6;
    const showSearch = Boolean(config.searchable) && options.length >= threshold;
    searchWrap.hidden = !showSearch;
    searchInput.value = '';

    renderOptionsList();
    const selectedIdx = filteredOptions.findIndex((o) => o.value === currentValue);
    focusedIndex = selectedIdx >= 0 ? selectedIdx : filteredOptions.length > 0 ? 0 : -1;

    menuEl.hidden = false;
    positionMenu();
    syncFocusHighlight();
    config.onOpenChange?.(true);

    if (showSearch) {
      window.setTimeout(() => {
        searchInput.focus();
      }, 0);
    }
  }

  function close(restoreFocus = false): void {
    if (!openState) return;
    openState = false;
    root.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    menuEl.hidden = true;
    menuEl.classList.remove('align-right', 'open-up');
    focusedIndex = -1;
    config.onOpenChange?.(false);
    if (restoreFocus) {
      trigger.focus();
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openState) {
      close(false);
    } else {
      open();
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (!openState && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      open();
    }
  });

  searchInput.addEventListener('input', () => {
    focusedIndex = 0;
    renderOptionsList();
    if (filteredOptions.length === 0) {
      focusedIndex = -1;
    }
    syncFocusHighlight();
  });

  root.addEventListener('keydown', (e) => {
    if (!openState) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }

    if (e.key === 'Tab') {
      close(false);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredOptions.length > 0) {
        focusedIndex = (focusedIndex + 1 + filteredOptions.length) % filteredOptions.length;
        syncFocusHighlight();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredOptions.length > 0) {
        focusedIndex = (focusedIndex - 1 + filteredOptions.length) % filteredOptions.length;
        syncFocusHighlight();
      }
      return;
    }

    if (e.key === 'Home') {
      if (document.activeElement === searchInput && searchInput.value.length > 0) return;
      e.preventDefault();
      if (filteredOptions.length > 0) {
        focusedIndex = 0;
        syncFocusHighlight();
      }
      return;
    }

    if (e.key === 'End') {
      if (document.activeElement === searchInput && searchInput.value.length > 0) return;
      e.preventDefault();
      if (filteredOptions.length > 0) {
        focusedIndex = filteredOptions.length - 1;
        syncFocusHighlight();
      }
      return;
    }

    if (e.key === 'Enter') {
      if (document.activeElement === trigger) return;
      e.preventDefault();
      e.stopPropagation();
      const targetOpt = filteredOptions[focusedIndex] || filteredOptions[0];
      if (targetOpt) {
        commitSelection(targetOpt);
      }
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!openState) return;
    const target = e.target as Node | null;
    if (!target || !root.contains(target)) {
      close(false);
    }
  });

  window.addEventListener('resize', () => {
    if (openState) {
      positionMenu();
    }
  });

  const record: SelectInstanceRecord = {
    root,
    isOpen: () => openState,
    close
  };
  activeInstances.add(record);

  return {
    el: root,
    trigger,
    getValue: () => currentValue,
    setValue(value: string) {
      currentValue = value;
      updateTriggerDisplay();
      if (openState) {
        renderOptionsList();
      }
    },
    setOptions(nextOptions: CustomSelectOption[], selectedValue?: string) {
      options = [...nextOptions];
      if (selectedValue !== undefined) {
        currentValue = selectedValue;
      } else if (!options.some((o) => o.value === currentValue)) {
        currentValue = options[0]?.value || '';
      }
      updateTriggerDisplay();
      if (openState) {
        renderOptionsList();
      }
    },
    isOpen: () => openState,
    open,
    close,
    focus: () => trigger.focus()
  };
}
