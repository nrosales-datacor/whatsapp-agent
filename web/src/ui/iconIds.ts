// Nombres de los íconos del panel (ui/Icons.tsx). Van en un .ts aparte para que lo que solo
// necesita el tipo (app/navigation.ts) no arrastre el componente: así navigation.ts se
// puede importar desde los tests de Node (test/unit), que no compilan JSX.

export type IconId =
  | "home" | "calendar" | "users" | "receipt" | "chart" | "chat" | "megaphone" | "gear"
  | "grid" | "plus" | "x" | "check" | "chevronDown" | "chevronLeft" | "chevronsUpDown"
  | "lock" | "key" | "shield" | "logout" | "sun" | "moon" | "mapPin" | "building"
  | "user" | "mail" | "eye" | "eyeOff" | "alert" | "cloudOff" | "refresh" | "sparkles"
  | "search" | "clock" | "chevronUp" | "trash" | "pencil" | "chevronRight" | "bell" | "bellOff"
  | "send" | "bot" | "image" | "mic" | "phone" | "checkCheck" | "hand" | "book"
  | "star" | "upload" | "download" | "filter";
