const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/projects/by-job/${encodeURIComponent(jobId)}`,
    { cache: "no-store" },
  );
  return Response.json(await response.json(), { status: response.status });
}
