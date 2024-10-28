


    // Hide loading screen
    const loadingScreen = document.getElementById('loading-screen');
    loadingScreen.style.display = 'none';

    // Restore form data
    const savedFormData = localStorage.getItem('botRequestFormData');
    if (savedFormData) {
        const formData = JSON.parse(savedFormData);
        Object.keys(formData).forEach(key => {
            const input = document.getElementById(key);
            if (input) {
                input.value = formData[key];
            }
        });
    }



// Notification handling
function showNotification(message, type = 'success') {
    // Remove any existing notifications
    const existingNotifications = document.querySelectorAll('.success-message, .error-message');
    existingNotifications.forEach(notification => notification.remove());

    // Create new notification
    const notification = document.createElement('div');
    notification.className = type === 'success' ? 'success-message' : 'error-message';
    
    notification.innerHTML = `
        <i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}"></i>
        <div class="message-content">${message}</div>
        <button class="close-notification" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    document.body.appendChild(notification);

    // Trigger animation to show the notification
    setTimeout(() => {
        notification.classList.add('show');
    }, 10); // Slight delay to ensure CSS transitions trigger

    // Auto-hide after 5 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300); // Wait for fade-out transition to complete
    }, 5000);
}

// Environment variables handling
document.getElementById('addEnvVar').addEventListener('click', () => {
    const container = document.createElement('div');
    container.className = 'env-var-group';
    container.innerHTML = `
        <button type="button" class="remove-env" onclick="this.parentElement.remove()">×</button>
        <div class="inputs">
            <input type="text" placeholder="Variable Name (e.g., API_KEY)" required>
            <input type="text" placeholder="Description of this variable" required>
        </div>
    `;
    document.getElementById('envVarsContainer').appendChild(container);
});

// Form validation
function validateRepoUrl(url) {
    const urlRegex = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9-_.]+$/;
    return urlRegex.test(url);
}

// Form submission handling
document.getElementById('botRequestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const botName = document.getElementById('botName').value;
    const repoUrl = document.getElementById('repoUrl').value;
    const deploymentCost = document.getElementById('deploymentCost').value;
    const websiteUrl = document.getElementById('websiteUrl').value;

    // Validate repository URL
    if (!validateRepoUrl(repoUrl)) {
        showNotification('Please enter a valid repository URL format (username/repository)', 'error');
        return;
    }

    // Collect environment variables
    const envVars = Array.from(document.getElementsByClassName('env-var-group')).map(group => {
        const inputs = group.getElementsByTagName('input');
        return {
            name: inputs[0].value.trim(),
            description: inputs[1].value.trim()
        };
    });

    // Validate environment variables
    if (envVars.some(v => !v.name || !v.description)) {
        showNotification('Please fill in all environment variable fields', 'error');
        return;
    }

    const data = {
        name: botName.trim(),
        repoUrl: repoUrl.trim(),
        deploymentCost: parseInt(deploymentCost),
        websiteUrl: websiteUrl.trim(),
        envVars
    };

    // Show loading screen
    const loadingScreen = document.getElementById('loading-screen');
    loadingScreen.style.display = 'flex';

    try {
        const response = await fetch('/bot-request', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            throw new Error(await response.text());
        }

        const result = await response.json();
        showNotification('Bot request submitted successfully!', 'success');

        // Reset form after successful submission
        setTimeout(() => {
            resetForm();
        }, 3000);
    } catch (error) {
        showNotification(`Error submitting request: ${error.message}`, 'error');
    } finally {
        loadingScreen.style.display = 'none';
    }
});

// Form reset utility function
function resetForm() {
    const form = document.getElementById('botRequestForm');
    form.reset();

    // Reset environment variables to initial state
    const envVarsContainer = document.getElementById('envVarsContainer');
    while (envVarsContainer.children.length > 1) {
        envVarsContainer.removeChild(envVarsContainer.lastChild);
    }

    // Reset the first env var group inputs
    const firstGroup = envVarsContainer.firstElementChild;
    if (firstGroup) {
        firstGroup.querySelectorAll('input').forEach(input => {
            input.value = '';
        });
    }
}

// Add input validation for deployment cost
document.getElementById('deploymentCost').addEventListener('input', function() {
    this.value = Math.max(0, Math.floor(this.value));
});

// Add input validation for website URL
document.getElementById('websiteUrl').addEventListener('input', function() {
    if (this.value && !this.value.startsWith('http')) {
        this.value = 'https://' + this.value;
    }
});

// Add form autosave functionality
const formInputs = document.querySelectorAll('input');
formInputs.forEach(input => {
    input.addEventListener('change', () => {
        const formData = {};
        formInputs.forEach(inp => {
            if (inp.id) {
                formData[inp.id] = inp.value;
            }
        });
        localStorage.setItem('botRequestFormData', JSON.stringify(formData));
    });
});

// Logout handling
document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        const response = await fetch('/logout');
        if (response.ok) window.location.href = '/login';
        else throw new Error('Logout failed');
    } catch (error) {
        showNotification('Logout failed', 'error');
    }
});

// Add event listeners for settings
document.getElementById('settingsBtn').addEventListener('click', () => {
    window.location.href = '/settings';
});
