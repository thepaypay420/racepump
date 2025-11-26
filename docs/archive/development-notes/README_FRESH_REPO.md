# Quick Start: Creating Fresh Repository

## ✅ Pre-Flight Checklist

Before running the script, verify:

- [x] Sensitive files removed from git tracking (already done)
- [x] `.gitignore` updated to exclude sensitive files (already done)
- [ ] You have a backup of your current repo (if needed)
- [ ] You've created a new empty repository on GitHub

## 🚀 Quick Steps

### 1. Create New GitHub Repository

1. Go to GitHub and create a new repository
2. Name it (e.g., `racepump` or `pump-racers`)
3. **Don't initialize with README, .gitignore, or license** (we have these)
4. Copy the repository URL

### 2. Run the Preparation Script

```bash
./prepare-fresh-repo.sh
```

The script will:
- ✅ Check for sensitive files
- ✅ Remove all git history
- ✅ Create a fresh repository
- ✅ Make an initial commit with all current files

### 3. Connect to Your New Repository

```bash
# Add your new repository as remote
git remote add origin https://github.com/yourusername/racepump.git

# Push to new repository
git branch -M main
git push -u origin main
```

### 4. Verify Everything is Clean

```bash
# Check no sensitive files are tracked
git ls-files | grep -E "(\.b58|keypair|private|secret|\.env)"
# Should return nothing

# Verify git history is clean
git log
# Should show only one commit: "Initial commit: RacePump..."

# Test clone in a new directory
cd /tmp
git clone https://github.com/yourusername/racepump.git test-clone
cd test-clone
ls -la data/
# Should NOT show .b58 files (they're ignored)
```

### 5. Make Repository Public

1. Go to repository settings on GitHub
2. Scroll to "Danger Zone"
3. Click "Change visibility" → "Make public"

## 📝 Update Documentation

After creating the fresh repo:

1. **Update any deployment scripts** that reference the old repo URL

2. **Consider adding a CHANGELOG.md** for future version tracking:
   ```markdown
   # Changelog

   ## [1.0.0] - 2025-01-XX
   - Initial public release
   - SOL betting with 5% rake
   - RACESwap with reflection mechanism
   - Edge Points system
   ```

## 🔒 Security Reminder

Even with a fresh repo, always:
- ✅ Never commit private keys
- ✅ Use environment variables for secrets
- ✅ Review `.gitignore` regularly
- ✅ Use GitHub's secret scanning (enabled by default)

## ❓ Troubleshooting

**Script fails with "sensitive files found":**
- The script found files that look sensitive but are tracked
- Check if they're actually sensitive or just have similar names
- Remove from tracking: `git rm --cached <file>`

**Can't push to new repo:**
- Make sure the new repo exists and is empty
- Check you have write access
- Verify the remote URL is correct

**Want to keep old repo as backup:**
- Don't delete the old repository
- Just stop using it
- Or rename it to `racepump-old` or similar
