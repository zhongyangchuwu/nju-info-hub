import { isIP } from 'node:net';

export interface GatewayConfig {
  upstreamOrigin: string;
  upstreamToken: string;
  readerToken: string;
  publisherUins: string[];
  host: string;
  port: number;
}

export function parseGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const origin = env.QZONE_GATEWAY_UPSTREAM_URL;
  const upstreamToken = env.QZONE_GATEWAY_UPSTREAM_TOKEN;
  const readerToken = env.QZONE_GATEWAY_READER_TOKEN;
  const publishers = env.QZONE_GATEWAY_PUBLISHER_UINS;
  const host = env.QZONE_GATEWAY_HOST;
  const port = env.QZONE_GATEWAY_PORT;
  if (!origin || !upstreamToken || !readerToken || !publishers || !host || !port) {
    throw new Error('Invalid QZone gateway configuration');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid QZone gateway configuration');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  const publisherUins = publishers.split(',').map((value) => value.trim());
  if (!/^https?:\/\/[^/?#@\s]+\/?$/i.test(origin) || /[\u0000-\u001f\u007f]/.test(origin) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      !/^[A-Za-z0-9._~+\/-]+=*$/.test(upstreamToken) ||
      !/^[A-Za-z0-9._~+\/-]+=*$/.test(readerToken) || upstreamToken === readerToken ||
      publisherUins.some((value) => !/^[1-9]\d*$/.test(value)) ||
      new Set(publisherUins).size !== publisherUins.length ||
      (host !== 'localhost' && isIP(host) === 0) ||
      !/^(0|[1-9]\d*)$/.test(port) || Number(port) > 65535) {
    throw new Error('Invalid QZone gateway configuration');
  }
  return { upstreamOrigin: url.origin, upstreamToken, readerToken, publisherUins, host, port: Number(port) };
}
