using System;
using System.Diagnostics;
using System.Drawing;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.IO;

class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        
        // Verifica primeiro se o servidor já está vivo
        try {
            using (HttpClient client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromMilliseconds(500);
                var task = client.GetAsync("http://127.0.0.1:3001/");
                task.Wait();
                if (task.Result.IsSuccessStatusCode) {
                    // Servidor já está rodando! Só abre o navegador e sai.
                    Process.Start("http://localhost:3001");
                    return;
                }
            }
        } catch {
            // Servidor não está rodando, vamos prosseguir com o boot normal.
        }
        
        // Dispara o servidor pesado em background
        ProcessStartInfo psi = new ProcessStartInfo("TabelaCiot_Server.exe");
        if (args.Length > 0) {
            psi.Arguments = string.Join(" ", args);
        }
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        
        try {
            Process.Start(psi);
        } catch {
            MessageBox.Show("Erro ao iniciar o motor TabelaCiot_Server.exe. Arquivo não encontrado.", "Erro", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Exibe a tela de carregamento animada
        Application.Run(new SplashForm());
    }
}

class SplashForm : Form
{
    private Label statusLabel;
    private Timer pingTimer;
    private int dots = 0;

    public SplashForm()
    {
        // Configurações da Janela sem bordas
        this.FormBorderStyle = FormBorderStyle.None;
        this.StartPosition = FormStartPosition.CenterScreen;
        this.Size = new Size(400, 150);
        this.BackColor = Color.FromArgb(41, 128, 185); // Azul profissional
        this.ShowInTaskbar = true;
        this.TopMost = true;

        // Borda suave arredondada
        this.Paint += (s, e) => {
            using (Pen p = new Pen(Color.FromArgb(52, 73, 94), 2))
            {
                e.Graphics.DrawRectangle(p, 0, 0, this.Width - 1, this.Height - 1);
            }
        };

        // Extrai o ícone da barra de tarefas
        try {
            this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        } catch {}

        // Título Principal
        Label titleLabel = new Label();
        titleLabel.Text = "Tabela CIOT";
        titleLabel.Font = new Font("Segoe UI", 16, FontStyle.Bold);
        titleLabel.ForeColor = Color.White;
        titleLabel.AutoSize = true;
        titleLabel.Location = new Point(100, 40);
        this.Controls.Add(titleLabel);

        // Label de Status (Carregando...)
        statusLabel = new Label();
        statusLabel.Text = "Inicializando sistema, por favor aguarde...";
        statusLabel.Font = new Font("Segoe UI", 10, FontStyle.Regular);
        statusLabel.ForeColor = Color.WhiteSmoke;
        statusLabel.AutoSize = true;
        statusLabel.Location = new Point(100, 75);
        this.Controls.Add(statusLabel);
        
        // Carrega a imagem HD (icon.png) da mesma pasta do executável
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string iconPngPath = Path.Combine(appDir, "icon.png");
        
        if (File.Exists(iconPngPath)) {
            PictureBox pb = new PictureBox();
            pb.Image = Image.FromFile(iconPngPath);
            pb.SizeMode = PictureBoxSizeMode.Zoom;
            pb.Size = new Size(60, 60);
            pb.Location = new Point(25, 45);
            this.Controls.Add(pb);
        }

        // Timer de monitoramento (ping a cada 1 seg)
        pingTimer = new Timer();
        pingTimer.Interval = 1000;
        pingTimer.Tick += PingTimer_Tick;
        pingTimer.Start();
    }

    private async void PingTimer_Tick(object sender, EventArgs e)
    {
        // Animação dos pontinhos
        dots = (dots + 1) % 4;
        string dotsStr = new string('.', dots);
        statusLabel.Text = string.Format("Inicializando motor{0}", dotsStr);

        // Tenta bater na API do servidor
        try
        {
            using (HttpClient client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromMilliseconds(2000); 
                // Usando 127.0.0.1 garante que não haverá problema de IPv4 vs IPv6
                HttpResponseMessage response = await client.GetAsync("http://127.0.0.1:3001/"); 
                
                // Se respondeu, o servidor Node está vivo e pronto!
                if (response.IsSuccessStatusCode)
                {
                    pingTimer.Stop();
                    this.Close();
                }
            }
        }
        catch
        {
            // Continua aguardando
        }
    }
}
