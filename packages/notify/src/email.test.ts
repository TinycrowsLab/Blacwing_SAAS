import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createSmtpEmailSender, renderEmail } from './email.js';

const DATA = {
  verifyUrl: 'https://app.example/signup/verify?token=abc_DEF-123',
  orgName: 'Acme & <Sons> "Ltd"',
  expiresInHours: 24,
};

describe('renderEmail signup_verify', () => {
  it('puts the link and the expiry in both bodies and addresses the message', () => {
    const message = renderEmail('signup_verify', 'owner@example.com', DATA);
    expect(message.to).toBe('owner@example.com');
    expect(message.subject).toContain('Verify');
    expect(message.text).toContain(DATA.verifyUrl);
    expect(message.text).toContain('24 hours');
    expect(message.html).toContain(`href="${DATA.verifyUrl}"`);
  });

  it('escapes the organisation name and the link in HTML but not in plain text', () => {
    const message = renderEmail('signup_verify', 'owner@example.com', {
      ...DATA,
      verifyUrl: 'https://app.example/v?a=1&b="2"',
    });
    expect(message.html).toContain('Acme &amp; &lt;Sons&gt; &quot;Ltd&quot;');
    expect(message.html).not.toContain('<Sons>');
    expect(message.html).toContain('href="https://app.example/v?a=1&amp;b=&quot;2&quot;"');
    expect(message.text).toContain('Acme & <Sons> "Ltd"');
  });

  it('uses the singular for one hour', () => {
    expect(renderEmail('signup_verify', 'a@b.co', { ...DATA, expiresInHours: 1 }).text).toContain(
      'expires in 1 hour.',
    );
  });
});

/** A one-connection SMTP stub that records what a client sent. */
function smtpStub(): { server: Server; received: Promise<string> } {
  let resolve: (value: string) => void = () => undefined;
  const received = new Promise<string>((done) => {
    resolve = done;
  });
  const server = createServer((socket) => {
    let inData = false;
    let buffer = '';
    let transcript = '';
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          transcript += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          resolve(transcript);
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        transcript += `${line}\n`;
        if (/^EHLO/i.test(line)) socket.write('250 stub\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return { server, received };
}

describe('createSmtpEmailSender', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('delivers a rendered message to the relay with the configured sender', async () => {
    const stub = smtpStub();
    server = stub.server;
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const sender = createSmtpEmailSender({ host: '127.0.0.1', port, from: 'no-reply@bw.example' });

    await sender.send(renderEmail('signup_verify', 'owner@example.com', DATA));

    const transcript = await stub.received;
    expect(transcript).toContain('MAIL FROM:<no-reply@bw.example>');
    expect(transcript).toContain('RCPT TO:<owner@example.com>');
    expect(transcript).toContain('Subject: Verify your email');
  });

  it('rejects when the relay is unreachable', async () => {
    // A port that was just released: the connection is refused at once.
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise((done) => probe.close(done));
    const sender = createSmtpEmailSender({ host: '127.0.0.1', port, from: 'no-reply@bw.example' });
    await expect(sender.send(renderEmail('signup_verify', 'a@b.co', DATA))).rejects.toThrow();
  });
});
