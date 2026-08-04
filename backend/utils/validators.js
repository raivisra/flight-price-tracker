// Email validation
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 100;
};

// Password validation: min 8 chars, 1 uppercase, 1 lowercase, 1 number
const validatePassword = (password) => {
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
};

// Airport code validation (3-letter IATA code)
const validateAirportCode = (code) => {
  return /^[A-Z]{3}$/.test(code);
};

module.exports = {
  validateEmail,
  validatePassword,
  validateAirportCode
};
