  // Dropdown handling
  document.addEventListener('DOMContentLoaded', () => {
    const profileBtn = document.getElementById('profileBtn');
    const profileDropdown = document.getElementById('profileDropdown');
    const addBotBtn = document.getElementById('addBotBtn');
  

    // Handle profile dropdown
    profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        profileDropdown.classList.toggle('show');
        botDropdown.classList.remove('show');
    });


    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        profileDropdown.classList.remove('show');

    });

    // Prevent dropdown from closing when clicking inside
    profileDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });


});
// Theme handling
const themeToggle = document.getElementById('themeToggle');
const root = document.documentElement;

function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    themeToggle.innerHTML = theme === 'dark' 
        ? '<i class="fas fa-sun"></i>' 
        : '<i class="fas fa-moon"></i>';
}

// Initialize theme
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
});

themeToggle.addEventListener('click', () => {
    const currentTheme = root.getAttribute('data-theme');
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
});