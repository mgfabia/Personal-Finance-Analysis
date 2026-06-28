// Phase 0 placeholder. The real UI (sign-in, data views, Plaid Link) is Phase 8;
// the throwaway end-to-end slice is Phase S. This page only proves the frontend
// builds and points at the backend API.

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Personal Finance</h1>
      <p>Phase 0 foundations — backend API: {apiUrl}</p>
    </main>
  );
}
