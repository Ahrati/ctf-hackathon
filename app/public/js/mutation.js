// Load and refresh password history.
async function refreshMutationHistory() {
    const list = document.getElementById("password-history");
    const message = document.getElementById("history-message");

    try {
        const response = await fetch("/api/mutation/history", {
            credentials: "same-origin",
            cache: "no-store",
        });

        if (!response.ok) {
            message.textContent =
                "Unable to load password history.";
            return;
        }

        const result = await response.json();

        list.replaceChildren();

        for (const password of result.passwords) {
            const item = document.createElement("li");
            item.textContent = password;
            list.appendChild(item);
        }

        message.textContent = result.count < result.limit
            ? ""
            : "Showing the 50 most recent expired passwords.";
    } catch {
        message.textContent =
            "Unable to connect to the server.";
    }
}

refreshMutationHistory();
setInterval(refreshMutationHistory, 5000);