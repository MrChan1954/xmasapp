import {
  ArrowRight,
  Bell,
  Cake,
  ChevronRight,
  Gift,
  History,
  House,
  Plus,
  Receipt,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The app's icon vocabulary. These names are used across every page, so the
 * shape of the props is deliberately unchanged from the hand-drawn set this
 * replaces: `{ size, strokeWidth, className }`, always `aria-hidden`.
 *
 * The festive glyphs have no lucide equivalent that sits alongside the rest of
 * the set, so they live in `festive/ornaments.tsx` and are re-exported here.
 *
 * THE SET IS DEMAND-DRIVEN, NOT ASPIRATIONAL. Q17 removed eight names nothing
 * imported -- Calendar, ChevronLeft, Dots, Lock, Mail, Pencil, Refresh and
 * Scales -- along with the lucide glyphs behind them. Adding one back is a
 * two-line change; keeping one nothing renders only makes this file read as a
 * catalogue of what is available rather than a list of what the app uses.
 */
export type IconProps = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

function icon(Glyph: LucideIcon) {
  return function Icon({ size = 20, strokeWidth = 1.8, className }: IconProps) {
    return <Glyph aria-hidden size={size} strokeWidth={strokeWidth} className={className} />;
  };
}

export const IconHome = icon(House);
export const IconPeople = icon(Users);
export const IconGift = icon(Gift);
export const IconPlus = icon(Plus);
export const IconClose = icon(X);
export const IconSearch = icon(Search);
export const IconChevronRight = icon(ChevronRight);
export const IconSparkle = icon(Sparkles);
export const IconShield = icon(ShieldCheck);
export const IconUser = icon(User);
export const IconReceipt = icon(Receipt);
export const IconHistory = icon(History);
export const IconArrowRight = icon(ArrowRight);
export const IconFilter = icon(SlidersHorizontal);
export const IconBell = icon(Bell);
export const IconCake = icon(Cake);
export const IconSettings = icon(Settings);

export { IconBauble, IconSnowflake, IconStocking, IconTree } from "./festive/ornaments";
