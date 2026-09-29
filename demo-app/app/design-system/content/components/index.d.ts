// window.CleanSpace: the app's shared UI components (app/src/components), bundled for React 18.
// Written from the component sources (plain JS); these types document the props, they are not type-checked.
// Styling comes from components/bundle.css (the app's stylesheet) over tokens.css.
import type * as React from 'react';

export type BadgeVariant = 'green' | 'amber' | 'yellow' | 'red' | 'blue' | 'purple' | 'slate' | 'white';
/** A solid status pill. Map the variant from the status, never pick a colour by hand. */
export interface BadgeProps { variant?: BadgeVariant; children?: React.ReactNode; style?: React.CSSProperties }
export declare function Badge(props: BadgeProps): React.ReactElement;
/** Paid/Active/Confirmed/Available → green; Pending/On Site/Prospect → amber; Overdue/Missed/Cancelled → red; In Progress → blue; else slate. */
export declare function statusBadgeVariant(status: string): BadgeVariant;
/** 'prospect' → "Prospect", 'inactive' → "Inactive", anything else → "Active". */
export declare function clientStatusLabel(status: string): string;
/** Company badge colours: lead amber, active green, inactive and vendor slate. */
export declare const DERIVED_STATUS_VARIANTS: { lead: 'amber'; active: 'green'; inactive: 'slate'; vendor: 'slate' };

/** A Badge for a conversation channel: sms green, email/dm blue, internal purple. */
export interface ChannelBadgeProps { channel: 'sms' | 'email' | 'internal' | 'dm' | string; label?: string }
export declare function ChannelBadge(props: ChannelBadgeProps): React.ReactElement;

/** A neutral pill for one user-defined tag. */
export interface TagChipProps { tag: { id?: string; label: string } | null; onRemove?: (tag: { id?: string; label: string }) => void; size?: 'sm' | 'xs' }
export declare function TagChip(props: TagChipProps): React.ReactElement | null;

/** Initials on a black disc in gold letters. */
export interface AvatarProps { initials: string; variant?: 1 | 2 | 3 | 4 | 5; size?: 'xs' | 'sm' | 'md' | 'lg' }
export declare function Avatar(props: AvatarProps): React.ReactElement;

/** An on/off switch that saves on flip. */
export interface ToggleProps { on: boolean; onChange: (next: boolean) => void; disabled?: boolean }
export declare function Toggle(props: ToggleProps): React.ReactElement;

/** A segmented pill switcher. Pass className 'tab-container-line' for the default look. */
export interface TabContainerProps { tabs: string[]; active: string; onChange: (tab: string) => void; className?: string }
export declare function TabContainer(props: TabContainerProps): React.ReactElement;

/** Underline tabs for a record's detail page. */
export interface SectionTabsProps { sections: Array<{ key: string; label: React.ReactNode; count?: number }>; activeKey: string; onSelect: (key: string) => void }
export declare function SectionTabs(props: SectionTabsProps): React.ReactElement;
/** The id to give each tab's panel: `detail-section-${key}`. */
export declare function sectionElementId(key: string): string;

/** The title row of a list or settings page. */
export interface PageHeaderProps { title: React.ReactNode; actions?: React.ReactNode }
export declare function PageHeader(props: PageHeaderProps): React.ReactElement;

/** A record page's header: back pill, title with status, actions. Navigation is inert in this bundle. */
export interface DetailHeaderProps { backTo?: string; backLabel?: string; title: React.ReactNode; subtitle?: React.ReactNode; badge?: React.ReactNode; actions?: React.ReactNode; relationship?: React.ReactNode }
export declare function DetailHeader(props: DetailHeaderProps): React.ReactElement;

/** The shared "← Back" pill for pages without a DetailHeader. Navigation is inert in this bundle. */
export interface BackLinkProps { to?: string; label?: string; className?: 'detail-back' | 'set-back' | string }
export declare function BackLink(props: BackLinkProps): React.ReactElement;

/** A KPI tile. With `to`, the tile is a drill-down link (inert in this bundle). */
export interface StatCardProps { value: React.ReactNode; label: React.ReactNode; trend?: React.ReactNode; trendDirection?: 'up' | 'down'; to?: string; navState?: unknown }
export declare function StatCard(props: StatCardProps): React.ReactElement;

/** What an empty list, tab or panel shows. */
export interface EmptyStateProps { icon?: React.ReactNode; title?: React.ReactNode; message?: React.ReactNode; action?: React.ReactNode }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;

/** The pager under a truncated table (20 rows a page in the app). Renders nothing on one page. */
export interface Pager { page: number; totalPages: number; setPage: (page: number) => void; start: number; end: number; total: number }
export interface ListPagerProps { pager: Pager | null; noun?: string }
export declare function ListPager(props: ListPagerProps): React.ReactElement | null;

/** The search field in a list table's header. */
export interface TableSearchProps { value: string; onChange: (text: string) => void; placeholder?: string; ariaLabel?: string }
export declare function TableSearch(props: TableSearchProps): React.ReactElement;

export interface SelectOption { value: string; label: React.ReactNode }
/** The themed dropdown; a bottom sheet at 640px and below. */
export interface SelectProps { value: string; onChange: (value: string) => void; options: SelectOption[]; ghost?: boolean; disabled?: boolean; placeholder?: string; id?: string; ariaLabel?: string }
export declare function Select(props: SelectProps): React.ReactElement;

/** A labelled form control: label, field, error or help. */
export interface FormFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: React.ReactNode; name?: string; as?: 'input' | 'textarea' | 'select';
  value?: string; onChange?: (event: { target: { value: string; name?: string } } | React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  type?: string; placeholder?: string; options?: Array<string | SelectOption>; required?: boolean;
  error?: React.ReactNode; help?: React.ReactNode; rows?: number; disabled?: boolean; ghost?: boolean; children?: React.ReactNode;
}
export declare function FormField(props: FormFieldProps): React.ReactElement;

/** A searchable single-select for filter bars; options[0] is the pinned reset row ("All …", value ''). */
export interface FilterSelectProps { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; ariaLabel?: string }
export declare function FilterSelect(props: FilterSelectProps): React.ReactElement;

/** A type-to-search combobox for one record. */
export interface SearchSelectProps {
  value: string | null; onChange: (value: string | null) => void; options: Array<{ value: string; label: string; sublabel?: string }>;
  placeholder?: string; searchPlaceholder?: string; disabled?: boolean; disabledText?: string | null; allowClear?: boolean; emptyText?: string;
}
export declare function SearchSelect(props: SearchSelectProps): React.ReactElement;

/** A textarea that grows with its content; `rows` is the minimum. */
export interface AutoGrowTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { value?: string; rows?: number; className?: string; style?: React.CSSProperties }
export declare function AutoGrowTextarea(props: AutoGrowTextareaProps): React.ReactElement;

/** A tel: link for a display phone number; renders nothing without one. */
export interface PhoneLinkProps { phone?: string | null; className?: string; onClick?: React.MouseEventHandler<HTMLAnchorElement>; title?: string }
export declare function PhoneLink(props: PhoneLinkProps): React.ReactElement | null;

/** The anchored panel behind every picker: a popover on desktop, a MobileSheet at 640px and below. */
export interface PopMenuProps extends React.HTMLAttributes<HTMLDivElement> { open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement>; className?: string; role?: string; sheetTitle?: string; children?: React.ReactNode }
export declare function PopMenu(props: PopMenuProps): React.ReactElement | null;

/** The bottom sheet every phone picker and filter drawer opens in. Portaled to document.body. */
export interface MobileSheetProps { open: boolean; onClose: () => void; title?: string; children?: React.ReactNode; footer?: React.ReactNode }
export declare function MobileSheet(props: MobileSheetProps): React.ReactElement | null;

/** A centred dialog. Portaled to document.body; Escape closes the top one. */
export interface ModalProps { open: boolean; onClose: () => void; title: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'wide'; children?: React.ReactNode }
export declare function Modal(props: ModalProps): React.ReactElement | null;

/** "Are you sure?" before an action that can't be undone. */
export interface ConfirmDialogProps { open: boolean; title?: React.ReactNode; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; variant?: 'default' | 'danger'; onConfirm?: () => void; onClose: () => void }
export declare function ConfirmDialog(props: ConfirmDialogProps): React.ReactElement | null;

export type DateRangeValue = { preset: string } | { preset?: '__custom'; from: string; to: string } | null;
export interface FilterOption { value: string; label: string; group?: string }
export interface FilterSpec {
  key: string; label: string; kind: 'multi' | 'single' | 'dateRange' | 'toggle';
  staticOptions?: FilterOption[]; options?: (ctx: unknown) => FilterOption[]; presets?: Array<{ value: string; label: string }>;
}
/** The shared faceted filter bar; one "Filters (N)" sheet at 640px and below. */
export interface FilterBarProps { specs: FilterSpec[]; values: Record<string, unknown>; setValue: (key: string, value: unknown) => void; clearAll: () => void; activeCount?: number; ctx?: unknown; action?: React.ReactNode }
export declare function FilterBar(props: FilterBarProps): React.ReactElement;
export interface MultiFacetProps { label?: string; value?: string[]; options?: FilterOption[]; onChange: (value: string[]) => void }
export declare function MultiFacet(props: MultiFacetProps): React.ReactElement;
export interface DateRangeFacetProps { label?: string; value: DateRangeValue; presets?: Array<{ value: string; label: string }>; onChange: (value: DateRangeValue) => void }
export declare function DateRangeFacet(props: DateRangeFacetProps): React.ReactElement;
export interface SegmentedFacetProps { label?: string; value: string; options?: Array<{ value: string; label: string }>; onChange: (value: string) => void }
export declare function SegmentedFacet(props: SegmentedFacetProps): React.ReactElement;
/** Today, 7d, 30d, 90d, This week, This month, This quarter, … */
export declare const DATE_PRESETS: Array<{ value: string; label: string }>;

export type IconName =
  | 'dashboard' | 'schedule' | 'clients' | 'invoices' | 'reminders' | 'messaging' | 'settings' | 'search' | 'plus' | 'edit'
  | 'trash' | 'check' | 'x' | 'camera' | 'bell' | 'bellOff' | 'building' | 'chart' | 'dollarCircle' | 'user' | 'lock'
  | 'logout' | 'archive' | 'tag' | 'filter' | 'mail' | 'phone' | 'mapPin' | 'phoneSolid' | 'mailSolid' | 'messagingSolid'
  | 'chevronRight' | 'chevronLeft' | 'arrowLeft' | 'chevronUp' | 'chevronDown' | 'resizeGrip' | 'dots' | 'star' | 'moon'
  | 'folder' | 'forms' | 'expand' | 'repeat' | 'warning' | 'paperclip' | 'upload' | 'box' | 'grip';
/** The app's stroke icon set (24px grid, currentColor). */
export interface IconProps extends React.SVGProps<SVGSVGElement> { name: IconName; size?: number; strokeWidth?: number; className?: string }
export declare function Icon(props: IconProps): React.ReactElement | null;

/** Wrap the app once; toasts render bottom-right. */
export declare function ToastProvider(props: { children?: React.ReactNode }): React.ReactElement;
export interface ToastOptions { duration?: number }
/** success / error / info return the toast id; duration defaults to 3000ms (0 = until dismissed). */
export declare function useToast(): { success(message: React.ReactNode, opts?: ToastOptions): number; error(message: React.ReactNode, opts?: ToastOptions): number; info(message: React.ReactNode, opts?: ToastOptions): number; dismiss(id: number): void };
/** Close on an outside tap and eat that tap (UI_RULES §100). */
export declare function useDismissTap(opts: { open?: boolean; ref: React.RefObject<HTMLElement>; ref2?: React.RefObject<HTMLElement> | null; onDismiss: () => void; escape?: boolean }): void;
/** True at 640px and below. */
export declare function useIsMobile(): boolean;

declare global {
  interface Window {
    CleanSpace: {
      Badge: typeof Badge; ChannelBadge: typeof ChannelBadge; TagChip: typeof TagChip; Avatar: typeof Avatar; Toggle: typeof Toggle;
      TabContainer: typeof TabContainer; SectionTabs: typeof SectionTabs; PageHeader: typeof PageHeader; DetailHeader: typeof DetailHeader;
      BackLink: typeof BackLink; StatCard: typeof StatCard; EmptyState: typeof EmptyState; ListPager: typeof ListPager; TableSearch: typeof TableSearch;
      FormField: typeof FormField; Select: typeof Select; FilterSelect: typeof FilterSelect; SearchSelect: typeof SearchSelect;
      AutoGrowTextarea: typeof AutoGrowTextarea; PhoneLink: typeof PhoneLink; PopMenu: typeof PopMenu; MobileSheet: typeof MobileSheet;
      Modal: typeof Modal; ConfirmDialog: typeof ConfirmDialog; FilterBar: typeof FilterBar; MultiFacet: typeof MultiFacet;
      DateRangeFacet: typeof DateRangeFacet; SegmentedFacet: typeof SegmentedFacet; Icon: typeof Icon; ToastProvider: typeof ToastProvider;
      useToast: typeof useToast; useDismissTap: typeof useDismissTap; useIsMobile: typeof useIsMobile;
      statusBadgeVariant: typeof statusBadgeVariant; clientStatusLabel: typeof clientStatusLabel; DERIVED_STATUS_VARIANTS: typeof DERIVED_STATUS_VARIANTS;
      sectionElementId: typeof sectionElementId; DATE_PRESETS: typeof DATE_PRESETS;
    };
  }
}
