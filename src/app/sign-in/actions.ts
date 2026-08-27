"use server";

import {signIn} from "@/auth";

export async function signInWithGoogle() {
  await signIn("google", {redirectTo: "/dashboard"});
}

export async function signInWithEmail(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  await signIn("nodemailer", {email, redirectTo: "/dashboard"});
}

export async function signInWithDevLogin(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  await signIn("dev-login", {email, redirectTo: "/dashboard"});
}
