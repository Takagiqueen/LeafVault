from pathlib import Path

IGNORE_DIRS = {
    ".git", ".venv", "venv", "__pycache__", "node_modules",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "dist", "build", ".next", ".idea", ".vscode"
}

IGNORE_FILES = {
    ".env", ".env.local", "leafvault.db", "app.db"
}

def print_tree(path: Path, prefix: str = ""):
    items = sorted(
        [p for p in path.iterdir() if p.name not in IGNORE_DIRS and p.name not in IGNORE_FILES],
        key=lambda p: (p.is_file(), p.name.lower())
    )

    for index, item in enumerate(items):
        connector = "└── " if index == len(items) - 1 else "├── "
        print(prefix + connector + item.name)

        if item.is_dir():
            extension = "    " if index == len(items) - 1 else "│   "
            print_tree(item, prefix + extension)

if __name__ == "__main__":
    root = Path(".")
    print(root.resolve().name)
    print_tree(root)