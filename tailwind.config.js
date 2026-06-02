/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./templates/**/*.html",
      "./static/js/**/*.js",
      "./static/js/modules/**/*.js",
      "./static/js/api/**/*.js",
      "./static/js/utils/**/*.js",
      "./static/**/*.js"
    ],
    theme: {
      extend: {},
    },
    plugins: [
      require('@tailwindcss/typography'),
    ],
    safelist: [
      "fixed",
      "grid",
      "flex",
      "hidden",
      "w-5",
      "h-5",
      "min-h-screen",
      "backdrop-blur",
    ],
  }
