import type {StaffRole} from "@/lib/models/Staff";

declare module "next-auth" {
  interface Session {
    user: {
      role?: StaffRole;
      staffId?: string;
    } & DefaultSessionUser;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: StaffRole;
    staffId?: string;
  }
}

// Re-declared locally to avoid importing the full next-auth default type surface just for this
// module augmentation - shape matches next-auth's built-in DefaultSession["user"].
interface DefaultSessionUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}
