/**
 * What the connector tells about itself (OpenTelemetry): always as Prometheus text at GET
 * /metrics, and pushed over OTLP/HTTP as well when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
import type { Counter, Histogram } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from './log.js';

export class Metrics {
  private readonly provider: MeterProvider;
  private readonly prometheus: PrometheusExporter;

  /** Calls asked for, by outcome: imported, existing, no_recording, not_found, unavailable, rejected, error. */
  readonly imports: Counter;
  /** How long fetching and storing a call took, in seconds. */
  readonly importSeconds: Histogram;
  /** Bytes of audio fetched from the dialer. */
  readonly downloadBytes: Counter;
  /** Events taken from the bus, by subject and outcome: ok, retry, dropped. */
  readonly eventsHandled: Counter;

  constructor(version: string, otlpEndpoint: string, log: Logger) {
    this.prometheus = new PrometheusExporter({ preventServerStart: true });
    const readers: MetricReader[] = [this.prometheus];
    if (otlpEndpoint) {
      const url = otlpEndpoint.replace(/\/$/, '') + '/v1/metrics';
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url }),
          exportIntervalMillis: 15_000,
        }),
      );
      log.info(`metrics go to ${url} every 15 s, and are at /metrics`);
    }
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({
        'service.name': 'likho-connector-ameyo',
        'service.version': version,
      }),
      readers,
    });
    const meter = this.provider.getMeter('likho-connector-ameyo', version);
    this.imports = meter.createCounter('likho_connector_imports', {
      description: 'Calls asked for, by outcome',
    });
    this.importSeconds = meter.createHistogram('likho_connector_import_seconds', {
      description: 'How long fetching and storing a call took',
      advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 20, 30, 60, 120] },
    });
    this.downloadBytes = meter.createCounter('likho_connector_download_bytes', {
      description: 'Bytes of audio fetched from the dialer',
    });
    this.eventsHandled = meter.createCounter('likho_connector_events_handled', {
      description: 'Events taken from the bus, by subject and outcome',
    });
    meter
      .createObservableGauge('likho_connector_up', { description: '1 while the connector runs' })
      .addCallback((result) => result.observe(1));
  }

  /** Serves the Prometheus text. */
  scrape(request: IncomingMessage, response: ServerResponse): void {
    this.prometheus.getMetricsRequestHandler(request, response);
  }

  async close(): Promise<void> {
    await this.provider.shutdown().catch(() => undefined);
  }
}
