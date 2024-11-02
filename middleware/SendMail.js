let nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: "102.212.247.90",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false
    }
});

const SendEmail = (subject, htmlTemplate, recepient) => {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: recepient,
      subject: subject,
      html: htmlTemplate
    };
  
    return new Promise((resolve, reject) => {
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log('Error occurred:', error);
        } else {
          console.log('Email sent:', info.response);
        }
      });
    });
  };

  module.exports = SendEmail;