export interface NavItem {
  href: string;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{href: "/dashboard", label: "Dashboard"}],
  },
  {
    label: "Clinic",
    items: [
      {href: "/calendar", label: "Calendar"},
      {href: "/appointments", label: "Appointments"},
    ],
  },
  {
    label: "DogTag",
    items: [
      {href: "/tags", label: "Tags"},
      {href: "/tags/issue", label: "Issue tag"},
      {href: "/verify", label: "Verify"},
      {href: "/verifications", label: "Verification history"},
      {href: "/activity", label: "On-chain activity"},
    ],
  },
  {
    label: "Billing",
    items: [{href: "/payments", label: "Payments"}],
  },
  {
    label: "Administration",
    items: [
      {href: "/setup", label: "Setup wizard"},
      {href: "/settings", label: "Settings"},
    ],
  },
];
