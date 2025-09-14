import nodemailer from 'nodemailer';

// Configure your SMTP transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10),
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send ride receipt email with direct signed URL link
 * @param {string} toEmail - rider's email address
 * @param {string} signedUrl - direct Supabase signed URL (full URL with token)
 */
export async function sendRideReceiptEmail(toEmail, signedUrl) {
  const mailOptions = {
    from: '"RideBeacon" <no-reply@ridebeacon.com>',
    to: toEmail,
    subject: 'Your Ride Receipt from RideBeacon',
    html: `
      <p>Thank you for riding with RideBeacon!</p>
      <p>Your receipt is ready. You can download it by clicking the link below:</p>
      <p><a href="${signedUrl}" target="_blank" rel="noopener noreferrer">Download your ride receipt</a></p>
      <p>If clicking the link doesn't work, copy and paste the URL below into your browser:</p>
      <p><small>${signedUrl}</small></p>
      <p>Thank you for choosing RideBeacon!</p>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.messageId);
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}
