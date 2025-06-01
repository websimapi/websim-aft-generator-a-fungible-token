import { WebsimSocket } from '@websim/websim-socket';

const room = new WebsimSocket({
    schema: {
        aft: {
            id: "uuid", 
            comment_id: "text", 
            comment_content: "text", 
            comment_author_username: "text", 
            comment_created_at: "timestamptz", 
            image_url: "text", 
            image_prompt: "text" 
        }
    }
});

class AFTGenerator {
    constructor() {
        this.afts = [];
        this.existingCommentIds = new Set();
        this.projectId = null;
        this.isInitializing = false; 
        this.initialLoadComplete = false; 
        this.initializeElements();
        this.bindEvents();
        this.initializeProjectAndLoadAFTs();
    }

    initializeElements() {
        this.galleryGrid = document.getElementById('galleryGrid');
        this.totalAfts = document.getElementById('totalAfts');
        this.modal = document.getElementById('aftModal');
        this.modalClose = document.getElementById('modalClose');
        this.modalImage = document.getElementById('modalImage');
        this.modalTitle = document.getElementById('modalTitle');
        this.modalComment = document.getElementById('modalComment');
        this.modalDate = document.getElementById('modalDate');
        this.modalAuthor = document.getElementById('modalAuthor'); 
    }

    bindEvents() {
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal || e.target.classList.contains('modal-overlay')) {
                this.closeModal();
            }
        });
    }

    async initializeProjectAndLoadAFTs() {
        if (this.isInitializing || this.initialLoadComplete) {
            console.log("Initialization already in progress or initial AFT/comment processing already completed. Skipping duplicate run.");
            return;
        }
        this.isInitializing = true;

        try {
            const project = await window.websim.getCurrentProject();
            if (project && project.id) {
                this.projectId = project.id;
            } else {
                console.error("Could not retrieve project ID.");
                this.showToast("Error: Could not retrieve project details.", "error");
                this.showEmptyState(); 
                this.isInitializing = false; 
                return;
            }
        } catch (error) {
            console.error("Error getting project details:", error);
            this.showToast("Error: Failed to get project details.", "error");
            this.showEmptyState();
            this.isInitializing = false; 
            return;
        }
        
        // First: Load all existing AFTs from database and render them
        console.log("Loading existing AFTs from database...");
        await this.loadAndRenderExistingAFTs();
        
        // Second: Only after database is fully loaded, process new comments
        console.log(`Database loaded with ${this.afts.length} existing AFTs. Existing comment IDs tracked: ${this.existingCommentIds.size}`);
        await this.processNewComments();

        this.isInitializing = false;
        this.initialLoadComplete = true; 
    }

    async loadAndRenderExistingAFTs() {
        try {
            // Get all existing AFTs from database
            const existingAFTs = await room.collection('aft').getList();
            console.log(`Retrieved ${existingAFTs.length} AFTs from database`);
            
            // Update local state and render
            this.updateLocalAFTs(existingAFTs);
            
            // Subscribe to future changes
            room.collection('aft').subscribe((updatedAFTs) => {
                this.handleAFTUpdates(updatedAFTs);
            });
            
            console.log(`Rendered ${this.afts.length} AFTs. Tracking ${this.existingCommentIds.size} comment IDs to prevent duplicates.`);
        } catch (error) {
            console.error('Error loading AFTs from database:', error);
            this.showToast("Error loading AFTs from database.", "error");
            this.showEmptyState();
            throw error; // Re-throw to prevent comment processing
        }
    }
    
    async processNewComments() {
        if (!this.projectId) {
            console.log("Project ID not available, skipping comment processing.");
            return;
        }

        try {
            const response = await fetch(`/api/v1/projects/${this.projectId}/comments`);
            if (!response.ok) {
                throw new Error(`Failed to fetch comments: ${response.statusText}`);
            }
            const commentsData = await response.json();
            
            if (commentsData.comments && commentsData.comments.data) {
                console.log(`Found ${commentsData.comments.data.length} total comments. Checking for new ones...`);
                let newCommentCount = 0;
                
                for (const commentObject of commentsData.comments.data) {
                    const comment = commentObject.comment;
                    if (comment && comment.id) {
                        if (this.existingCommentIds.has(comment.id)) {
                            console.log(`Skipping comment ${comment.id} - already has AFT`);
                            continue;
                        }
                        
                        console.log(`Processing new comment ${comment.id} by ${comment.author?.username || 'Unknown'}`);
                        await this.generateAFTFromComment(comment);
                        newCommentCount++;
                    }
                }
                
                console.log(`Processed ${newCommentCount} new comments`);
            }
        } catch (error) {
            console.error("Error processing new comments:", error);
            this.showToast("Error fetching or processing comments.", "error");
        }
    }

    async loadAndSubscribeToAFTs() {
        // This method is now replaced by loadAndRenderExistingAFTs
        // Keeping for backward compatibility but redirecting
        return this.loadAndRenderExistingAFTs();
    }
    
    _extractTextRecursively(node) {
        if (!node) return "";
        let textContent = "";
        if (node.type === "text" && typeof node.text === 'string') {
            textContent += node.text;
        }

        if (node.children && Array.isArray(node.children)) {
            textContent += node.children.map(child => this._extractTextRecursively(child)).join(" ");
        } else if (node.type === 'link' && node.children && Array.isArray(node.children)) { 
             textContent += node.children.map(child => this._extractTextRecursively(child)).join("");
        }
        
        if (node.type === "paragraph" && textContent.length > 0) {
             textContent += "\n";
        } else if (textContent.length > 0 && !textContent.endsWith(" ") && !textContent.endsWith("\n")) {
            textContent += " ";
        }
        return textContent;
    }

    extractCommentText(comment) {
        if (comment.raw_content && typeof comment.raw_content === 'string' && comment.raw_content.trim() !== "") {
            return comment.raw_content.trim();
        }
        if (comment.content && comment.content.type === 'document' && comment.content.children) {
            const extracted = comment.content.children.map(child => this._extractTextRecursively(child).trim()).join('\n').replace(/\s+/g, ' ').trim();
            if (extracted) return extracted;
        }
        console.warn(`Could not extract text for comment ${comment.id}. Raw: ${comment.raw_content}, Structured: ${JSON.stringify(comment.content)}`);
        return null; 
    }

    async generateAFTFromComment(comment) {
        try {
            const commentText = this.extractCommentText(comment);
            if (!commentText || commentText.trim() === "") {
                console.warn(`Skipping comment ${comment.id} due to empty or unextractable content.`);
                return;
            }

            const imagePrompt = `Digital art inspired by the sentiment: "${commentText.substring(0, 250)}". Style: vibrant, abstract, positive energy, high detail, colorful.`;
            
            let imageUrl;
            try {
                this.showToast(`Generating image for AFT from comment by @${comment.author ? comment.author.username : 'Unknown'}...`, 'info');
                const imageResult = await websim.imageGen({
                    prompt: imagePrompt,
                    aspect_ratio: "4:3" 
                });
                imageUrl = imageResult.url;
                if (!imageUrl) {
                    throw new Error("Image generation failed to return a URL.");
                }
            } catch (genError) {
                console.error(`Error generating image for comment ${comment.id}:`, genError);
                this.showToast("Error generating image for AFT. Using placeholder.", "error");
                imageUrl = `https://picsum.photos/seed/${comment.id.replace(/-/g, '')}/400/300`;
            }

            const newAftData = {
                comment_id: comment.id,
                comment_content: commentText,
                comment_author_username: comment.author ? comment.author.username : 'Unknown',
                comment_created_at: comment.created_at,
                image_url: imageUrl,
                image_prompt: imagePrompt
            };

            await room.collection('aft').create(newAftData);
            this.existingCommentIds.add(comment.id); 
            this.showToast(`New AFT generated for comment by @${newAftData.comment_author_username}!`, 'success');
        } catch (error) {
            console.error(`Error generating AFT for comment ${comment.id}:`, error);
            this.showToast("Error generating an AFT from a comment.", "error");
        }
    }

    updateLocalAFTs(aftRecords) {
        this.afts = [];
        this.existingCommentIds.clear();
        this.galleryGrid.innerHTML = '';
        
        if (!aftRecords || aftRecords.length === 0) {
            this.showEmptyState();
        } else {
            const sortedAFTs = [...aftRecords].sort((a, b) => 
                new Date(b.comment_created_at || b.created_at) - new Date(a.comment_created_at || a.created_at) 
            );
            
            for (const aft of sortedAFTs) {
                const aftData = {
                    id: aft.id,
                    comment_id: aft.comment_id,
                    comment: aft.comment_content,
                    imageUrl: aft.image_url,
                    comment_created_at: aft.comment_created_at || aft.created_at, 
                    prompt: aft.image_prompt,
                    author_username: aft.comment_author_username || "Anonymous"
                };
                this.afts.push(aftData);
                if(aft.comment_id) this.existingCommentIds.add(aft.comment_id);
                this.renderAFT(aftData);
            }
        }
        this.updateStats();
    }

    handleAFTUpdates(updatedAFTs) {
        this.updateLocalAFTs(updatedAFTs);
    }

    showEmptyState() {
        this.galleryGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🎨</div>
                <h3>No AFTs Yet</h3>
                <p>AFTs will appear here automatically when created from comments or if they already exist!</p>
            </div>
        `;
    }

    renderAFT(aft) {
        const emptyState = this.galleryGrid.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        const aftElement = document.createElement('div');
        aftElement.className = 'aft-card';
        aftElement.addEventListener('click', () => this.openModal(aft));

        const displayId = typeof aft.id === 'string' ? aft.id.slice(-3).toUpperCase() : String(aft.id).slice(-3).toUpperCase();

        aftElement.innerHTML = `
            <img src="${aft.imageUrl}" alt="AFT #${displayId}" class="aft-image">
            <div class="aft-info">
                <h3 class="aft-title">AFT #${displayId}</h3>
                <p class="aft-author">by @${aft.author_username}</p>
                <p class="aft-comment">${aft.comment.substring(0,100)}${aft.comment.length > 100 ? '...' : ''}</p>
            </div>
        `;

        this.galleryGrid.prepend(aftElement); 
    }

    openModal(aft) {
        this.modalImage.src = aft.imageUrl;
        const displayId = typeof aft.id === 'string' ? aft.id.slice(-3).toUpperCase() : String(aft.id).slice(-3).toUpperCase();
        this.modalTitle.textContent = `AFT #${displayId}`;
        this.modalComment.textContent = aft.comment;
        this.modalDate.textContent = new Date(aft.comment_created_at).toLocaleDateString();
        this.modalAuthor.textContent = `@${aft.author_username}`;
        
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    closeModal() {
        this.modal.classList.remove('show');
        document.body.style.overflow = '';
    }

    updateStats() {
        this.totalAfts.textContent = this.afts.length;
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        
        const styles = {
            position: 'fixed',
            bottom: '20px', 
            left: '50%',    
            transform: 'translateX(-50%)', 
            padding: '15px 25px',
            borderRadius: '12px',
            color: '#ffffff',
            fontWeight: '600',
            zIndex: '2000',
            animation: 'slideInUp 0.4s ease-out, fadeOut 0.4s ease-out 2.6s forwards', 
            maxWidth: 'calc(100% - 40px)',
            textAlign: 'center',
            boxShadow: '0 5px 15px rgba(0,0,0,0.2)',
        };

        if (type === 'success') {
            styles.background = 'linear-gradient(135deg, #4ecdc4, #44a08d)';
        } else if (type === 'error') {
            styles.background = 'linear-gradient(135deg, #ff6b6b, #ee5a52)';
        } else { 
            styles.background = 'linear-gradient(135deg, #667eea, #764ba2)';
        }

        Object.assign(toast.style, styles);
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    }
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideInUp { 
        from {
            transform: translate(-50%, 100%); 
            opacity: 0;
        }
        to {
            transform: translate(-50%, 0);
            opacity: 1;
        }
    }

    @keyframes fadeOut { 
        from {
            opacity: 1;
        }
        to {
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', () => {
    new AFTGenerator();
});