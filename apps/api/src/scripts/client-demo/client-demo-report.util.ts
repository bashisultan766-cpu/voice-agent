import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientDemoReport } from './client-demo.types';

export function printClientDemoReport(report: ClientDemoReport): void {
  console.log('\n=== Client Demo — Launch Readiness Report ===\n');
  console.log(`Mode:        ${report.mode}`);
  console.log(`Overall:     ${report.pass ? 'PASS' : 'FAIL'}`);
  console.log(`Trace ID:    ${report.traceId ?? '—'}`);
  console.log(`Call:        ${report.callResult ?? '—'}`);
  if (report.product) {
    console.log(`Product:     ${report.product.productFound ? report.product.title ?? 'found' : 'NOT FOUND'}`);
    console.log(`Checkout:    ${report.product.checkoutLinkCreated ? 'created' : 'missing'}`);
  }
  if (report.email) {
    console.log(
      `Email:       ${report.email.emailSent ? report.email.deliveryStatus ?? 'sent' : 'not delivered'} → ${report.email.recipient}`,
    );
  }
  if (report.latency.totalFlowMs != null) {
    console.log(`Total flow:  ${report.latency.totalFlowMs}ms`);
  }
  if (report.providerErrors.length) {
    console.log('\nProvider errors:');
    for (const e of report.providerErrors) console.log(`  - ${e}`);
  }
  console.log('\n--- Full JSON report ---\n');
  console.log(JSON.stringify(report, null, 2));
}

export function writeClientDemoReportFile(report: ClientDemoReport): string | undefined {
  const dir = process.env.CLIENT_DEMO_REPORT_DIR?.trim() || join(process.cwd(), 'client-demo-reports');
  try {
    mkdirSync(dir, { recursive: true });
    const filename = `client-demo-${report.mode}-${report.generatedAt.replace(/[:.]/g, '-')}.json`;
    const path = join(dir, filename);
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nReport saved: ${path}\n`);
    return path;
  } catch (err) {
    console.warn(
      `Could not write report file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
