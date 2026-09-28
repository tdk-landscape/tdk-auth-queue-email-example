import { createTransport } from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
  attachment: { filename: string; content: string };
}

/**
 * The only thing the worker knows about "sending email". Locally this is plain SMTP
 * into Mailpit; in the cloud the same SMTP interface is offered by SES and SendGrid,
 * or you add an API-based implementation of this interface.
 */
export interface Mailer {
  send(email: Email): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    host: string,
    port: number,
    private readonly from: string,
  ) {
    this.transport = createTransport({ host, port, secure: false, tls: { rejectUnauthorized: false } });
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      attachments: [{ filename: email.attachment.filename, content: email.attachment.content, contentType: 'text/csv' }],
    });
  }
}

/** Test double. */
export class MemoryMailer implements Mailer {
  readonly sent: Email[] = [];
  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}
